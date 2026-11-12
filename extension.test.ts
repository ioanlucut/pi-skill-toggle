import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSkillToggle,
  type SkillToggleConfig,
  type SkillVisibilityStore,
} from './index.ts';

const systemPrompt = `<available_skills>
  <skill>
    <name>codebase-design</name>
    <description>Test-driven development.</description>
    <location>/skills/codebase-design/SKILL.md</location>
  </skill>
  <skill>
    <name>example-test</name>
    <description>Unit testing.</description>
    <location>/skills/example-test/SKILL.md</location>
  </skill>
  <skill>
    <name>stories</name>
    <description>Story files.</description>
    <location>/skills/stories/SKILL.md</location>
  </skill>
</available_skills>`;

const skills = [
  {
    name: 'codebase-design',
    description: 'Test-driven development.',
    filePath: '/skills/codebase-design/SKILL.md',
    sourceInfo: { scope: 'user', origin: 'top-level', source: 'auto' },
    disableModelInvocation: false,
  },
  {
    name: 'example-test',
    description: 'Unit testing.',
    filePath: '/skills/example-test/SKILL.md',
    disableModelInvocation: false,
  },
  {
    name: 'stories',
    description: 'Story files.',
    filePath: '/skills/stories/SKILL.md',
    sourceInfo: { scope: 'user', origin: 'package', source: 'git:github.com/example/stories' },
    disableModelInvocation: false,
  },
];

const projectRoot = '/projects/is24-i18n-ppa';

function emptyConfig(): SkillToggleConfig {
  return { onDemandSkills: [], projects: {} };
}

function createStores(config: SkillToggleConfig = emptyConfig()) {
  const store: SkillVisibilityStore = {
    load: vi.fn(async () => structuredClone(config)),
    save: vi.fn(async (next) => {
      config = structuredClone(next);
    }),
    update: vi.fn(async (change) => {
      const next = await store.load();
      await change(next);
      await store.save(next);
      return next;
    }),
  };
  return { store };
}

function createHarness(store: SkillVisibilityStore) {
  const commands = new Map<string, { handler: Function; getArgumentCompletions?: Function }>();
  const handlers = new Map<string, Function>();
  const pi = {
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    getCommands: () => [
      { name: 'example-progress', source: 'extension' },
      ...skills.map(({ name }) => ({ name: `skill:${name}`, source: 'skill' })),
    ],
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
  };
  registerSkillToggle(pi as never, store);
  return { commands, handlers };
}

function createContext() {
  return {
    cwd: projectRoot,
    mode: 'tui',
    hasUI: true,
    getSystemPromptOptions: () => ({ skills }),
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      custom: vi.fn(),
      theme: {
        bold: (text: string) => text,
        italic: (text: string) => text,
        fg: vi.fn((color: string, text: string) =>
          `<${color}>${text}</${color}>`
        ),
      },
    },
  };
}

function createAgentStartEvent(catalog = skills) {
  const options: { skills: typeof skills; forceSystemPrompt?: string } = { skills: catalog };
  return {
    messageType: 'user',
    get systemPrompt() {
      return options.forceSystemPrompt ?? formatSkillsForPrompt(options.skills as unknown as Skill[]);
    },
    systemPromptOptions: options,
  };
}

async function startAgent(handlers: Map<string, Function>, ctx: object) {
  const event = createAgentStartEvent();
  await handlers.get('before_agent_start')?.(event, ctx);
  return { systemPrompt: event.systemPrompt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/skill-toggle', () => {
  it('hides nothing from the model without settings', async () => {
    const { store } = createStores();
    const { handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    const result = await startAgent(handlers, ctx);

    for (const { name } of skills) {
      expect(result.systemPrompt).toContain(`<name>${name}</name>`);
    }
  });

  it('persists a global on-demand skill and removes it from the next model prompt', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('off codebase-design --global', ctx);
    const result = await startAgent(handlers, ctx);

    expect(store.save).toHaveBeenCalledWith({
      onDemandSkills: ['codebase-design'],
      projects: {},
    });
    expect(result.systemPrompt).not.toContain('<name>codebase-design</name>');
    expect(result.systemPrompt).toContain('<name>example-test</name>');
  });

  it('reports when a global restore remains project-on-demand', async () => {
    const { store } = createStores({
      onDemandSkills: ['stories'],
      projects: { [projectRoot]: { onDemand: ['stories'], autoDiscovered: [] } },
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('on stories --global', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'stories is now on globally but stays off here (repository)',
      'info',
    );
  });

  it('persists a project on-demand skill without touching the global list', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('off codebase-design', ctx);
    const result = await startAgent(handlers, ctx);

    expect(store.save).toHaveBeenCalledWith({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: ['codebase-design'], autoDiscovered: [] },
      },
    });
    expect(result.systemPrompt).not.toContain('<name>codebase-design</name>');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `codebase-design is now off for ${projectRoot}`,
      'info',
    );
  });

  it('lets a project auto-discovered override restore a globally muted skill', async () => {
    const { store } = createStores({
      onDemandSkills: ['codebase-design'],
      projects: {},
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('on codebase-design', ctx);
    const result = await startAgent(handlers, ctx);

    expect(result.systemPrompt).toContain('<name>codebase-design</name>');
  });

  it('clears a project override', async () => {
    const { store } = createStores({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: ['codebase-design'], autoDiscovered: [] },
      },
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('reset codebase-design', ctx);
    const result = await startAgent(handlers, ctx);

    expect(store.save).toHaveBeenCalledWith({
      onDemandSkills: [],
      projects: { [projectRoot]: { onDemand: [], autoDiscovered: [] } },
    });
    expect(result.systemPrompt).toContain('<name>codebase-design</name>');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'codebase-design repository override removed; now on (default)',
      'info',
    );
  });

  it('shows owner, source, token cost, catalog share, and description without usage lines', async () => {
    const { store } = createStores({ onDemandSkills: ['stories'], projects: {} });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    const screens: string[] = [];
    ctx.ui.custom.mockImplementation(async (factory) => {
      const selector = factory({ requestRender() {} }, ctx.ui.theme, {
        matches: () => false,
      }, () => {});
      screens.push(selector.render(160).join('\n'));
      await selector.handleInput('\u001b[B');
      await selector.handleInput('\u001b[B');
      screens.push(selector.render(160).join('\n'));
    });

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('', ctx);

    const pickerText = screens[0].replace(/<[^>]+>/g, '');
    expect(pickerText).toMatch(/→ codebase-design\s+on · user/);
    expect(pickerText).toMatch(/example-test\s+on · Unknown/);
    expect(pickerText).toMatch(/stories\s+off · git:github\.com\/example\/stories/);
    expect(pickerText).toContain('on here · default');
    expect(pickerText).toMatch(/~\d+ tok · \d+\.\d%/);
    expect(pickerText).toContain('Test-driven development.');
    expect(pickerText).not.toMatch(/This repo:|Anywhere:|recorded use|loads/);
    expect(screens[1]).toContain(
      'off here · global',
    );
  });

  it('shows the rule pattern as the source of a rule-decided row', async () => {
    const { store } = createStores({
      onDemandSkills: [],
      projects: {},
      rules: [{ repo: 'github.com/example/*', onDemand: ['codebase-*'] }],
    });
    const { commands, handlers } = createHarness(store);
    const cwd = mkdtempSync(join(tmpdir(), 'skill-toggle-rule-'));
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/web.git'], { cwd });
    const ctx = { ...createContext(), cwd };
    const screens: string[] = [];
    ctx.ui.custom.mockImplementation(async (factory) => {
      const selector = factory({ requestRender() {} }, ctx.ui.theme, {
        matches: () => false,
      }, () => {});
      // Off rows sort last; move to codebase-design.
      await selector.handleInput('\u001b[B');
      await selector.handleInput('\u001b[B');
      screens.push(selector.render(160).join('\n'));
    });

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('', ctx);
    await commands.get('skill-toggle')?.handler('list', ctx);

    rmSync(cwd, { recursive: true, force: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('codebase-design  off  rule github.com/example/*'),
      'info',
    );
    expect(screens[0].replace(/<[^>]+>/g, '')).toContain(
      'off here · rule github.com/example/*',
    );
    // The header totals count the rule-off skill as off.
    expect(screens[0].split('\n')[1].replace(/<[^>]+>/g, '')).toMatch(
      /^2 of 3 on · ~\d+ tok · ~\d+ tok saved$/,
    );
  });

  it('applies a repository toggle on Space without a scope submenu or Done button', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    ctx.ui.custom.mockImplementation(async (factory) => {
      const selector = factory({ requestRender() {} }, ctx.ui.theme, {
        matches: () => false,
      }, () => {});
      await selector.handleInput(' ');
    });

    await handlers.get('session_start')?.({}, ctx);
    await commands.get('skill-toggle')?.handler('', ctx);
    const result = await startAgent(handlers, ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledWith({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: ['codebase-design'], autoDiscovered: [] },
      },
    });
    expect(result.systemPrompt).not.toContain('<name>codebase-design</name>');
  });

  it('filters custom-message runs', async () => {
    const { store } = createStores({
      onDemandSkills: ['codebase-design'],
      projects: {},
    });
    const { handlers } = createHarness(store);
    const ctx = createContext();
    const event = createAgentStartEvent();
    event.messageType = 'custom';
    await handlers.get('session_start')?.({}, ctx);

    const result = await handlers.get('before_agent_start')?.(event, ctx);

    expect(result).toBeUndefined();
    expect(event.systemPromptOptions).not.toHaveProperty('forceSystemPrompt');
    expect(event.systemPromptOptions.skills.map((skill) => skill.name)).toEqual(['example-test', 'stories']);
  });

  it('preserves filtering when an earlier extension forces a rendered prompt', async () => {
    const { store } = createStores({
      onDemandSkills: ['codebase-design'],
      projects: {},
    });
    const { handlers } = createHarness(store);
    const ctx = createContext();
    const event = createAgentStartEvent();
    event.systemPromptOptions.forceSystemPrompt = systemPrompt;
    await handlers.get('session_start')?.({}, ctx);

    const result = await handlers.get('before_agent_start')?.(event, ctx);

    expect(result).toBeUndefined();
    expect(event.systemPromptOptions.forceSystemPrompt).toContain('<name>example-test</name>');
    expect(event.systemPromptOptions.forceSystemPrompt).not.toContain('<name>codebase-design</name>');
  });

  it('starts without writing settings and keeps repository overrides', async () => {
    const { store } = createStores({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: ['codebase-design'], autoDiscovered: [] },
      },
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();

    await expect(handlers.get('session_start')?.({}, ctx)).resolves
      .toBeUndefined();
    expect(store.update).not.toHaveBeenCalled();
    expect((await startAgent(handlers, ctx)).systemPrompt).not.toContain(
      '<name>codebase-design</name>',
    );
    await commands.get('skill-toggle')?.handler('off example-test', ctx);

    expect(store.save).toHaveBeenLastCalledWith({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: ['codebase-design', 'example-test'], autoDiscovered: [] },
      },
    });
  });

  it('retains persisted prompt behavior when a toggle save fails', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    await handlers.get('session_start')?.({}, ctx);
    store.update = vi.fn().mockRejectedValue(new Error('Read-only config'));

    await commands.get('skill-toggle')?.handler('off codebase-design', ctx);
    const result = await startAgent(handlers, ctx);

    expect(result.systemPrompt).toContain('<name>codebase-design</name>');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Skill toggle failed: Read-only config',
      'error',
    );
  });

  it('reports a project override that keeps a globally muted skill auto-discovered', async () => {
    const { store } = createStores({
      onDemandSkills: [],
      projects: {
        [projectRoot]: { onDemand: [], autoDiscovered: ['codebase-design'] },
      },
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler('off codebase-design --global', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'codebase-design is now off globally but stays on here (repository)',
      'info',
    );
  });

  it('lists each skill with its effective mode and source', async () => {
    const { store } = createStores({
      onDemandSkills: ['stories', 'example-test'],
      projects: { [projectRoot]: { onDemand: [], autoDiscovered: ['example-test'] } },
    });
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler('list', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      [
        `Skills for ${projectRoot}:`,
        'codebase-design  on   default',
        'example-test     on   repository',
        'stories          off  global',
      ].join('\n'),
      'info',
    );
  });

  it.each(['print', 'json', 'rpc'])('prints the list without arguments in %s mode', async (mode) => {
    const { store } = createStores({ onDemandSkills: ['stories'], projects: {} });
    const { commands, handlers } = createHarness(store);
    const ctx = { ...createContext(), mode, hasUI: mode === 'rpc' };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler('', ctx);

    const output = mode === 'rpc'
      ? vi.mocked(ctx.ui.notify).mock.calls[0]?.[0]
      : log.mock.calls[0]?.[0];
    expect(output).toContain('stories          off  global');
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('prints errors to the console without a UI', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = { ...createContext(), mode: 'print', hasUI: false };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler('off', ctx);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Use: /skill-toggle'));
    error.mockRestore();
  });

  it('rejects an unknown skill without writing', async () => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler('off codebase-dezign', ctx);

    expect(store.update).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Unknown skill: codebase-dezign', 'error');
  });

  it.each([
    'toggle codebase-design',
    'on-demand codebase-design',
    'off',
    'off codebase-design extra',
    'reset codebase-design --global',
    'list --global',
    'list stories',
    'off codebase-design --global --global',
    'toString codebase-design',
  ])('rejects wrong arguments: %s', async (args) => {
    const { store } = createStores();
    const { commands, handlers } = createHarness(store);
    const ctx = createContext();
    await handlers.get('session_start')?.({}, ctx);

    await commands.get('skill-toggle')?.handler(args, ctx);

    expect(store.update).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Use: /skill-toggle [list] | on|off <skill> [--global] | reset <skill>',
      'error',
    );
  });

  it('completes actions, then skill names, then --global', async () => {
    const { store } = createStores();
    const { commands } = createHarness(store);
    const complete = (prefix: string) =>
      commands.get('skill-toggle')?.getArgumentCompletions?.(prefix)
        ?.map((item: { value: string }) => item.value) ?? null;

    expect(complete('')).toEqual(['on ', 'off ', 'reset ', 'list']);
    expect(complete('o')).toEqual(['on ', 'off ']);
    expect(complete('off ')).toEqual([
      'off codebase-design ',
      'off example-test ',
      'off stories ',
    ]);
    expect(complete('reset st')).toEqual(['reset stories ']);
    expect(complete('off stories ')).toEqual(['off stories --global']);
    expect(complete('off stories --g')).toEqual(['off stories --global']);
    expect(complete('reset stories ')).toBeNull();
    expect(complete('list ')).toBeNull();
    expect(complete('toString ')).toBeNull();
    expect(complete('off stories --global')).toBeNull();
  });

  it('warns with the settings problem and keeps Pi working', async () => {
    const { store } = createStores();
    store.load = vi.fn().mockRejectedValue(
      new Error('Skill toggle rules[0].repo must be a non-empty string'),
    );
    const { handlers } = createHarness(store);
    const ctx = createContext();

    await handlers.get('session_start')?.({}, ctx);
    const result = await startAgent(handlers, ctx);

    expect(result.systemPrompt).toContain('<name>codebase-design</name>');
    for (const call of vi.mocked(ctx.ui.notify).mock.calls) {
      expect(call).toEqual([
        expect.stringContaining('Skill toggle rules[0].repo must be a non-empty string'),
        'warning',
      ]);
    }
    expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
  });

  it('prints the settings warning to the console without a UI', async () => {
    const { store } = createStores();
    store.load = vi.fn().mockRejectedValue(new Error('Skill toggle version must be 1'));
    const { handlers } = createHarness(store);
    const ctx = { ...createContext(), mode: 'print', hasUI: false };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handlers.get('session_start')?.({}, ctx);
    await startAgent(handlers, ctx);

    expect(error).toHaveBeenCalledTimes(2);
    for (const call of error.mock.calls) {
      expect(call).toEqual([expect.stringContaining('Skill toggle version must be 1')]);
    }
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not claim to enable skills locked on-demand by frontmatter', async () => {
  const { store } = createStores({
    onDemandSkills: ['codebase-design'],
    projects: {},
  });
  const { commands, handlers } = createHarness(store);
  const ctx = createContext();
  ctx.getSystemPromptOptions = () => ({
    skills: skills.map((skill) => ({
      ...skill,
      disableModelInvocation: skill.name === 'codebase-design',
    })),
  });
  await handlers.get('session_start')?.({}, ctx);
  vi.mocked(store.update).mockClear();

  await commands.get('skill-toggle')?.handler('on codebase-design', ctx);

  expect(store.update).not.toHaveBeenCalled();
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    'codebase-design is off by its own frontmatter (disable-model-invocation) and cannot be changed here.',
    'warning',
  );
});
});
