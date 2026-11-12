import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSkillToggle } from './index.ts';
import { resolveProjectSkillPolicy } from './project.ts';
import { createSkillVisibilityStore } from './store.ts';

const exec = promisify(execFile);
const directories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'skill-sharing-'));
  directories.push(directory);
  return directory;
}

async function repository(directory: string, remote?: string) {
  await mkdir(directory, { recursive: true });
  await exec('git', ['init', '--quiet', directory]);
  if (remote) {
    await exec('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
  }
}

function session(cwd: string, configPath: string) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  registerSkillToggle(
    {
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (name: string, command: { handler: Function }) =>
        commands.set(name, command),
    } as never,
    createSkillVisibilityStore(configPath),
  );
  const skills = ['codebase-design', 'example-test'].map((name) => ({
    name,
    description: `Fixture skill ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    disableModelInvocation: false,
  }));
  const ctx = {
    cwd,
    mode: 'tui',
    hasUI: true,
    getSystemPromptOptions: () => ({ skills }),
    ui: { notify: vi.fn(), custom: vi.fn() },
  };
  return {
    ui: ctx.ui,
    start: () => handlers.get('session_start')!({}, ctx),
    toggle: (args: string) => commands.get('skill-toggle')!.handler(args, ctx),
    prompt: async () => {
      const options = { skills };
      const event = {
        messageType: 'user',
        get systemPrompt() {
          return formatSkillsForPrompt(options.skills as unknown as Skill[]);
        },
        systemPromptOptions: options,
      };
      await handlers.get('before_agent_start')!(event, ctx);
      return event.systemPrompt;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe('repository sharing', () => {
  it('shares overrides between already-running sessions and preserves their separate edits', async () => {
    const directory = await workspace();
    const path = join(directory, 'settings.json');
    const a = session(directory, path);
    const b = session(directory, path);
    await a.start();
    await b.start();

    await a.toggle('off codebase-design');
    expect(await b.prompt()).not.toContain('<name>codebase-design</name>');
    await b.toggle('off example-test');

    const config = await createSkillVisibilityStore(path).load();
    expect(Object.values(config.projects)[0].onDemand.sort()).toEqual([
      'codebase-design',
      'example-test',
    ]);
  });

  it('saves an edit from a stale session without erasing another session’s selections', async () => {
    const directory = await workspace();
    const path = join(directory, 'settings.json');
    const a = session(directory, path);
    const b = session(directory, path);
    await a.start();
    await b.start();

    await a.toggle('off codebase-design');
    await b.toggle('off example-test');

    expect(
      Object.values((await createSkillVisibilityStore(path).load()).projects)[0]
        .onDemand,
    ).toEqual(['codebase-design', 'example-test']);
  });

  it(
    'shares one identity between worktrees and clones using SSH or HTTPS',
    async () => {
      const directory = await workspace();
      const main = join(directory, 'main');
      const worktree = join(directory, 'feature');
      const clone = join(directory, 'renamed-clone');
      await repository(main, 'git@github.com:Example/Portal.git');
      await exec('git', [
        '-C',
        main,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.org',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Initial',
      ]);
      await exec('git', [
        '-C',
        main,
        'worktree',
        'add',
        '--quiet',
        '-b',
        'feature',
        worktree,
      ]);
      await repository(clone, 'https://github.com/example/portal/');
      const configPath = join(directory, 'settings.json');
      const mainSession = session(main, configPath);
      const worktreeSession = session(worktree, configPath);
      const cloneSession = session(clone, configPath);
      await Promise.all([
        mainSession.start(),
        worktreeSession.start(),
        cloneSession.start(),
      ]);

      await mainSession.toggle('off codebase-design');

      expect(await worktreeSession.prompt()).not.toContain('<name>codebase-design</name>');
      expect(await cloneSession.prompt()).not.toContain('<name>codebase-design</name>');
      const policies = await Promise.all(
        [main, worktree, clone].map(resolveProjectSkillPolicy),
      );
      expect(new Set(policies.map((policy) => policy.key)).size).toBe(1);
      expect(policies[0].key).toBe('repo:github.com/example/portal');
    },
  );

  it('shares remote-less worktrees but not unrelated repositories with the same directory name', async () => {
    const directory = await workspace();
    const main = join(directory, 'main', 'project');
    const worktree = join(directory, 'feature');
    const other = join(directory, 'other', 'project');
    await repository(main);
    await repository(other);
    await exec('git', [
      '-C',
      main,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.org',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Initial',
    ]);
    await exec('git', [
      '-C',
      main,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'feature',
      worktree,
    ]);

    const policies = await Promise.all(
      [main, worktree, other].map(resolveProjectSkillPolicy),
    );

    expect(policies[0].key).toMatch(/^git:/);
    expect(policies[1].key).toBe(policies[0].key);
    expect(policies[2].key).not.toBe(policies[0].key);
  });
});
