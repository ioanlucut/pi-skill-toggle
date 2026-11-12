import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { skillCatalogNames } from './catalog.ts';

/**
 * Runs the extension inside a real pi AgentSession, wired the way pi's own
 * test harness does it: real resource loader, real extension runner, and a
 * faux in-process model that records every Context pi sends. Assertions read
 * the captured system prompt, so they cover what the model actually receives
 * rather than what the filter returns in isolation.
 */

const EXTENSION_PATH = join(import.meta.dirname, 'index.ts');
const REPOSITORY_ORIGIN = 'git@github.com:example/skill-toggle-fixture.git';
const REPOSITORY_KEY = 'repo:github.com/example/skill-toggle-fixture';
const FIXTURE_SKILLS = ['alpha', 'beta', 'gamma', 'delta'] as const;

const captureModel: Model<any> = {
  id: 'capture-model',
  name: 'Capture',
  api: 'capture-api' as any,
  provider: 'capture',
  baseUrl: 'http://127.0.0.1:0',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

function createCaptureProvider(contexts: TranscriptContext[], initialReadPath?: string): InlineExtension {
  return {
    name: 'capture-provider',
    factory: (pi) => {
      pi.registerProvider('capture', {
        baseUrl: captureModel.baseUrl,
        apiKey: 'capture-key',
        api: captureModel.api,
        models: [{
          id: captureModel.id,
          name: captureModel.name,
          reasoning: false,
          input: ['text'],
          cost: captureModel.cost,
          contextWindow: captureModel.contextWindow,
          maxTokens: captureModel.maxTokens,
        }],
        streamSimple: (model, context) => {
          contexts.push(context);
          const stream = createAssistantMessageEventStream();
          const readPath = contexts.length === 1 ? initialReadPath : undefined;
          const message: AssistantMessage = {
            role: 'assistant',
            content: readPath
              ? [{ type: 'toolCall', id: 'fixture-read', name: 'read', arguments: { path: readPath } }]
              : [{ type: 'text', text: 'ok' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: readPath ? 'toolUse' : 'stop',
            timestamp: Date.now(),
          };
          queueMicrotask(() => {
            stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
            stream.push({ type: 'done', reason: readPath ? 'toolUse' : 'stop', message });
          });
          return stream;
        },
      });
    },
  };
}

function createCommandRecorder(commands: string[]): InlineExtension {
  return {
    name: 'command-recorder',
    factory: (pi) => {
      pi.on('before_agent_start', () => {
        commands.splice(0, commands.length, ...pi.getCommands()
          .filter((command) => command.source === 'skill')
          .map((command) => command.name));
      });
    },
  };
}

type Fixture = {
  root: string;
  agentDir: string;
  cwd: string;
  writeSkillToggle: (config: unknown) => void;
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'pi-skill-toggle-session-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  for (const name of FIXTURE_SKILLS) {
    const directory = join(agentDir, 'skills', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\nBody of ${name} skill.\n`,
    );
  }
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', REPOSITORY_ORIGIN], { cwd });
  return {
    root,
    agentDir,
    cwd,
    writeSkillToggle: (config) =>
      writeFileSync(join(agentDir, 'skill-toggle.json'), JSON.stringify(config, null, 2)),
  };
}

async function startSession(
  fixture: Fixture,
  options: {
    withExtension: boolean;
    extras?: InlineExtension[];
    initialReadPath?: string;
    extensionPathsBefore?: string[];
  },
): Promise<{ session: AgentSession; contexts: TranscriptContext[]; errors: string[] }> {
  const contexts: TranscriptContext[] = [];
  const errors: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [...(options.extensionPathsBefore ?? []), ...(options.withExtension ? [EXTENSION_PATH] : [])],
    additionalSkillPaths: [join(fixture.agentDir, 'skills')],
    extensionFactories: [createCaptureProvider(contexts, options.initialReadPath), ...(options.extras ?? [])],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    model: captureModel,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(fixture.cwd),
  });
  // Like print and interactive mode: binding emits session_start, which resolves the repository key.
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => errors.push(`${error.extensionPath}: ${error.error}`),
  });
  return { session, contexts, errors };
}

function systemPromptOf(context: TranscriptContext): string {
  return getCurrentSystemPrompt(context.messages);
}

describe('/skill-toggle inside a real pi session', () => {
  let fixture: Fixture;
  let previousAgentDir: string | undefined;
  const sessions: AgentSession[] = [];

  beforeEach(() => {
    fixture = createFixture();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
    fixture.writeSkillToggle({
      onDemandSkills: ['beta', 'gamma'],
      projects: {
        [REPOSITORY_KEY]: { onDemand: ['alpha'], autoDiscovered: ['gamma'] },
      },
    });
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('exposes every fixture skill to the model when the extension is not loaded', async () => {
    const { session, contexts } = await startSession(fixture, { withExtension: false });
    sessions.push(session);
    await session.prompt('hello');

    expect(contexts).toHaveLength(1);
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual([...FIXTURE_SKILLS].sort());
  });

  it('hides nothing and writes no settings in a fresh agent directory', async () => {
    rmSync(join(fixture.agentDir, 'skill-toggle.json'));
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    expect(errors).toEqual([]);
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual([...FIXTURE_SKILLS].sort());
    expect(existsSync(join(fixture.agentDir, 'skill-toggle.json'))).toBe(false);
  });

  it('removes on-demand skills from the system prompt pi sends to the model', async () => {
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    expect(errors).toEqual([]);
    expect(contexts).toHaveLength(1);
    const systemPrompt = systemPromptOf(contexts[0]);
    // alpha: repository override; beta: global; gamma: global but restored by repository override.
    expect([...skillCatalogNames(systemPrompt)].sort()).toEqual(['delta', 'gamma']);
    expect(systemPrompt).not.toContain('alpha');
    expect(systemPrompt).not.toContain('beta');
  });

  it('records only auto-discovered skills in the structured session prompt', async () => {
    const { session, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    const context = session.sessionManager.buildSessionContext();
    expect(errors).toEqual([]);
    expect([...skillCatalogNames(getCurrentSystemPrompt(context.messages))].sort()).toEqual(['delta', 'gamma']);
  });

  it('updates tool guidance without restoring on-demand skills during a run', async () => {
    const { session, contexts, errors } = await startSession(fixture, {
      withExtension: true,
      initialReadPath: join(fixture.agentDir, 'skills', 'delta', 'SKILL.md'),
      extras: [{
        name: 'change-tools-after-read',
        factory: (pi) => {
          pi.on('tool_result', () => pi.setActiveTools(['bash']));
        },
      }],
    });
    sessions.push(session);
    await session.prompt('read the fixture');

    expect(errors).toEqual([]);
    expect(contexts).toHaveLength(2);
    expect(systemPromptOf(contexts[0])).toContain('- read:');
    expect(systemPromptOf(contexts[1])).not.toContain('- read:');
    expect(systemPromptOf(contexts[1])).toContain('- bash:');
    expect([...skillCatalogNames(systemPromptOf(contexts[1]))].sort()).toEqual(['delta', 'gamma']);
  });

  it('keeps hidden skills registered as /skill: commands and expands them on request', async () => {
    const commands: string[] = [];
    const { session, contexts } = await startSession(fixture, {
      withExtension: true,
      extras: [createCommandRecorder(commands)],
    });
    sessions.push(session);
    await session.prompt('/skill:alpha do the thing');

    expect(commands.sort()).toEqual(FIXTURE_SKILLS.map((name) => `skill:${name}`).sort());
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual(['delta', 'gamma']);
    const userMessage = contexts[0].messages.find((message) => message.role === 'user');
    const userText = (userMessage?.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? '').join('');
    expect(userText).toContain('<skill name="alpha"');
    expect(userText).toContain('Body of alpha skill.');
    expect(userText).toContain('do the thing');
  });

  it('applies settings changed by another writer before the next prompt', async () => {
    const { session, contexts } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('first');
    fixture.writeSkillToggle({ onDemandSkills: [], projects: {} });
    await session.prompt('second');

    expect(contexts).toHaveLength(2);
    expect([...skillCatalogNames(systemPromptOf(contexts[1]))].sort()).toEqual([...FIXTURE_SKILLS].sort());
  });

  it('filters extension-generated user runs and writes no usage file', async () => {
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('human request');
    await session.sendUserMessage('extension-generated request');
    await session.prompt('/skill:alpha do the thing');

    expect(errors).toEqual([]);
    expect(contexts).toHaveLength(3);
    expect(contexts.map((context) => [...skillCatalogNames(systemPromptOf(context))].sort()))
      .toEqual([['delta', 'gamma'], ['delta', 'gamma'], ['delta', 'gamma']]);
    expect(existsSync(join(fixture.agentDir, 'skill-usage.json'))).toBe(false);
  });

  it('prints the effective modes for /skill-toggle in print mode', async () => {
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    const printed: unknown[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((text) => printed.push(text));
    try {
      await session.prompt('/skill-toggle');
      await session.prompt('/skill-toggle off delta');
      await session.prompt('/skill-toggle list');
    } finally {
      log.mockRestore();
    }

    expect(errors).toEqual([]);
    expect(contexts).toHaveLength(0);
    expect(printed).toEqual([
      [`Skills for ${REPOSITORY_KEY}:`, 'alpha  off  repository', 'beta   off  global', 'delta  on   default', 'gamma  on   repository'].join('\n'),
      `delta is now off for ${REPOSITORY_KEY}`,
      [`Skills for ${REPOSITORY_KEY}:`, 'alpha  off  repository', 'beta   off  global', 'delta  off  repository', 'gamma  on   repository'].join('\n'),
    ]);
  });

  it('hides the skills of a rule that matches the repository origin', async () => {
    fixture.writeSkillToggle({
      version: 1,
      onDemandSkills: [],
      rules: [
        { repo: 'github.com/example/*', onDemand: ['al*', 'beta'] },
        { repo: 'github.com/other/*', onDemand: ['delta'] },
      ],
    });
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    expect(errors).toEqual([]);
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual(['delta', 'gamma']);
  });

  it('lets an exact repository override beat a matching rule', async () => {
    fixture.writeSkillToggle({
      onDemandSkills: [],
      projects: { [REPOSITORY_KEY]: { onDemand: [], autoDiscovered: ['alpha'] } },
      rules: [{ repo: 'github.com/example/skill-toggle-fixture', onDemand: ['alpha', 'beta'] }],
    });
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    expect(errors).toEqual([]);
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual(['alpha', 'delta', 'gamma']);
  });

  it('keeps every skill and keeps working with an invalid settings file', async () => {
    fixture.writeSkillToggle({ onDemandSkills: ['alpha'], rules: [{ onDemand: ['beta'] }] });
    const { session, contexts, errors } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    expect(errors).toEqual([]);
    expect([...skillCatalogNames(systemPromptOf(contexts[0]))].sort()).toEqual([...FIXTURE_SKILLS].sort());
  });

  it('drops the whole skill section when every skill is on-demand', async () => {
    fixture.writeSkillToggle({ onDemandSkills: [...FIXTURE_SKILLS], projects: {} });
    const { session, contexts } = await startSession(fixture, { withExtension: true });
    sessions.push(session);
    await session.prompt('hello');

    const systemPrompt = systemPromptOf(contexts[0]);
    expect(systemPrompt).not.toContain('<available_skills>');
    expect(systemPrompt).not.toContain('The following skills provide');
  });

  it('drops the empty catalog and its guidance from a forced system prompt', async () => {
    fixture.writeSkillToggle({ onDemandSkills: [...FIXTURE_SKILLS], projects: {} });
    // Loads before the toggle and forces Pi's own rendering, so the test follows Pi's current guidance wording.
    const forcePromptPath = join(fixture.root, 'force-system-prompt.ts');
    writeFileSync(
      forcePromptPath,
      "export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: `Forced.\\n\\n${event.systemPrompt}` }));\n",
    );
    const { session, contexts, errors } = await startSession(fixture, {
      withExtension: true,
      extensionPathsBefore: [forcePromptPath],
    });
    sessions.push(session);
    await session.prompt('hello');

    const systemPrompt = systemPromptOf(contexts[0]);
    expect(errors).toEqual([]);
    expect(systemPrompt).toContain('Forced.');
    expect(systemPrompt).toContain('<cwd>');
    expect(systemPrompt).not.toContain('available_skills');
    expect(systemPrompt).not.toContain('Fixture skill');
    expect(systemPrompt).not.toContain("skill's");
    expect(systemPrompt).not.toContain('SKILL.md');
  });
});
