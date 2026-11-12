import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryKey, resolveProjectSkillPolicy } from './project.ts';

let testDirectory: string | undefined;

afterEach(async () => {
  if (testDirectory) await rm(testDirectory, { force: true, recursive: true });
  testDirectory = undefined;
});

describe('repository identity', () => {
  it.each([
    ['git@github.com:Example/Portal.git', 'repo:github.com/example/portal'],
    [
      'ssh://git@github.com:22/Example/Portal.git',
      'repo:github.com/example/portal',
    ],
    [
      'https://ignored-user:ignored-password@github.com/Example/Portal.git?ignored=query',
      'repo:github.com/example/portal',
    ],
    [
      'https://github.com/another-owner/Portal.git',
      'repo:github.com/another-owner/portal',
    ],
    [
      'https://git.example.org/Example/Portal.git',
      'repo:git.example.org/Example/Portal',
    ],
    [
      'ssh://git@git.example.org:2222/Example/Portal.git',
      'repo:git.example.org:2222/Example/Portal',
    ],
    ['/local/git/portal', undefined],
  ])('normalizes %s without storing authentication', (remote, expected) => {
    expect(repositoryKey(remote)).toBe(expected);
  });
});

describe('project skill policy', () => {
  it('keys a nested working directory by its Git root', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-project-'));
    const projectRoot = join(testDirectory, 'service');
    const workingDirectory = join(projectRoot, 'src', 'handlers');
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(workingDirectory, { recursive: true });

    expect(await resolveProjectSkillPolicy(workingDirectory)).toEqual({
      root: await realpath(projectRoot),
      key: await realpath(projectRoot),
    });
  });
});
