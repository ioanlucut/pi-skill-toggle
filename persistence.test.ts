import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkillVisibilityStore } from './store.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const exec = promisify(execFile);
let directory: string;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('settings file writes', () => {
  it.each([0o600, 0o640, 0o644])('preserves existing permissions %i on replacement', async (mode) => {
    directory = await mkdtemp(join(tmpdir(), 'skill-mode-'));
    const path = join(directory, 'settings.json');
    await writeFile(path, '{}');
    await chmod(path, mode);

    await createSkillVisibilityStore(path).save({ onDemandSkills: ['tdd'], projects: {} });

    expect((await stat(path)).mode & 0o777).toBe(mode);
  });

  it('creates private settings files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-mode-'));
    const path = join(directory, 'settings.json');

    await createSkillVisibilityStore(path).save({ onDemandSkills: ['tdd'], projects: {} });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).onDemandSkills).toEqual(['tdd']);
  });

  it('writes through a symlink and keeps the link and the target permissions', async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-link-'));
    const source = join(directory, 'source.json');
    const path = join(directory, 'settings.json');
    await writeFile(source, '{"onDemandSkills":[]}');
    await chmod(source, 0o644);
    await symlink(source, path);

    await createSkillVisibilityStore(path).save({ onDemandSkills: ['tdd'], projects: {} });

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect((await stat(source)).mode & 0o777).toBe(0o644);
    expect(JSON.parse(await readFile(source, 'utf8')).onDemandSkills).toEqual(['tdd']);
    expect((await readdir(directory)).sort()).toEqual(['settings.json', 'source.json']);
  });

  it('refuses to replace a dangling symlink', async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-link-'));
    const path = join(directory, 'settings.json');
    await symlink(join(directory, 'missing.json'), path);

    await expect(createSkillVisibilityStore(path).save({ onDemandSkills: [], projects: {} }))
      .rejects.toThrow('dangling symlink');

    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  it('keeps the old file and leaves no temporary file when the write fails', async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-fail-'));
    const path = join(directory, 'settings.json');
    await writeFile(path, 'original');
    vi.mocked(rename).mockRejectedValueOnce(new Error('refused replacement'));

    await expect(createSkillVisibilityStore(path).save({ onDemandSkills: ['tdd'], projects: {} }))
      .rejects.toThrow('refused replacement');

    expect(await readFile(path, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['settings.json']);
  });

  it('leaves complete, valid JSON after many independent Node writers', async () => {
    directory = await mkdtemp(join(tmpdir(), 'skill-writers-'));
    const path = join(directory, 'settings.json');
    const worker = `
      import { createSkillVisibilityStore } from './store.ts';
      const [path, name] = process.argv.slice(1);
      const store = createSkillVisibilityStore(path);
      for (let index = 0; index < 10; index++) {
        await store.update(config => { config.onDemandSkills.push(name + index); });
      }
    `;
    let writing = true;
    const reads: unknown[] = [];
    const reader = (async () => {
      // Every read during the writes must see a whole file, never a partial one.
      while (writing) reads.push(await createSkillVisibilityStore(path).load());
    })();

    await Promise.all(
      Array.from({ length: 6 }, (_, writer) =>
        exec(process.execPath, ['--input-type=module', '-e', worker, path, `w${writer}-`], {
          cwd: import.meta.dirname,
        })),
    );
    writing = false;
    await reader;

    const { onDemandSkills } = await createSkillVisibilityStore(path).load();
    expect(onDemandSkills.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
    expect(await readdir(directory)).toEqual(['settings.json']);
  }, 20_000);
});
