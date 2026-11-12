import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSkillVisibilityStore,
  resolveSkillVisibilityConfigPath,
} from './store.ts';

let testDirectory: string | undefined;

afterEach(async () => {
  if (testDirectory) await rm(testDirectory, { force: true, recursive: true });
  testDirectory = undefined;
});

describe('skill visibility config', () => {
  it('leaves every skill auto-discovered without a settings file', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');

    expect(await createSkillVisibilityStore(configPath).load()).toEqual({
      onDemandSkills: [],
      projects: {},
    });
  });

  it('survives a new store instance including project overrides', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    const config = {
      onDemandSkills: ['tdd', 'agent-transcript'],
      projects: {
        '/projects/example-portal': {
          onDemand: ['example-ticket'],
          autoDiscovered: ['x-generate-catalog'],
        },
      },
    };

    await createSkillVisibilityStore(configPath).save(config);

    expect(await createSkillVisibilityStore(configPath).load()).toEqual(config);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(config);
  });

  it('drops empty project override entries on save', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');

    await createSkillVisibilityStore(configPath).save({
      onDemandSkills: [],
      projects: {
        '/projects/empty': { onDemand: [], autoDiscovered: [] },
      },
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      onDemandSkills: [],
      projects: {},
    });
  });

  it('updates the managed source without replacing its symlink', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const sourcePath = join(testDirectory, 'managed-skill-toggle.json');
    const configPath = join(testDirectory, 'skill-toggle.json');
    await writeFile(
      sourcePath,
      `${JSON.stringify({ onDemandSkills: ['tdd'] }, null, 2)}\n`,
      'utf8',
    );
    await chmod(sourcePath, 0o640);
    await symlink(sourcePath, configPath);

    await createSkillVisibilityStore(configPath).save({
      onDemandSkills: ['example-test'],
      projects: {},
    });

    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect((await stat(sourcePath)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(sourcePath, 'utf8'))).toEqual({
      onDemandSkills: ['example-test'],
      projects: {},
    });
  });

  it('refuses to replace a dangling managed symlink', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    await symlink(join(testDirectory, 'missing-source.json'), configPath);

    await expect(
      createSkillVisibilityStore(configPath).save({
        onDemandSkills: [],
        projects: {},
      }),
    ).rejects.toThrow('dangling symlink');

    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
  });

  it('loads configs written before project overrides existed', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    await writeFile(
      configPath,
      `${JSON.stringify({ onDemandSkills: ['tdd'] }, null, 2)}\n`,
      'utf8',
    );

    expect(await createSkillVisibilityStore(configPath).load()).toEqual({
      onDemandSkills: ['tdd'],
      projects: {},
    });
  });

  it('does not read the legacy hiddenSkills key', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    await writeFile(configPath, JSON.stringify({ hiddenSkills: ['tdd'] }));

    await expect(createSkillVisibilityStore(configPath).load()).rejects
      .toThrow('onDemandSkills');
  });

  it.each([
    { projects: [] },
    {
      projects: {
        'repo:github.com/example/project': {
          onDemand: 'tdd',
          autoDiscovered: [],
        },
      },
    },
    { projects: { 'repo:github.com/example/project': null } },
  ])(
    'rejects malformed project selections without rewriting the file: %j',
    async (malformed) => {
      testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
      const configPath = join(testDirectory, 'skill-toggle.json');
      const contents = JSON.stringify({ onDemandSkills: [], ...malformed });
      await writeFile(configPath, contents);

      await expect(
        createSkillVisibilityStore(configPath).update((config) => {
          config.onDemandSkills.push('example-test');
        }),
      ).rejects.toThrow('projects');

      expect(await readFile(configPath, 'utf8')).toBe(contents);
    },
  );

  it('reads version, $schema, and rules, and keeps them when a change is saved', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    const header = { $schema: './skill-toggle.schema.json', version: 1 };
    const rules = [
      { repo: 'github.com/acme/*', onDemand: ['deploy-*'] },
      { repo: 'github.com/acme/web', autoDiscovered: ['deploy-build'] },
    ];
    await writeFile(
      configPath,
      JSON.stringify({ ...header, onDemandSkills: [], rules }),
    );

    const loaded = await createSkillVisibilityStore(configPath).load();
    await createSkillVisibilityStore(configPath).update((config) => {
      config.onDemandSkills.push('tdd');
    });

    expect(loaded).toEqual({ ...header, onDemandSkills: [], projects: {}, rules });
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...header,
      onDemandSkills: ['tdd'],
      projects: {},
      rules,
    });
  });

  it('reads a file without version as version 1 and does not add keys to it', async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    await writeFile(configPath, JSON.stringify({ onDemandSkills: [] }));

    await createSkillVisibilityStore(configPath).update((config) => {
      config.onDemandSkills.push('tdd');
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      onDemandSkills: ['tdd'],
      projects: {},
    });
  });

  it.each([
    [{ version: 2 }, 'version must be 1'],
    [{ version: '1' }, 'version must be 1'],
    [{ $schema: 7 }, '$schema must be a string'],
    [{ rules: {} }, 'rules must be an array'],
    [{ rules: [null] }, 'rules[0] must be an object'],
    [{ rules: [{ onDemand: ['tdd'] }] }, 'rules[0].repo must be a non-empty string'],
    [{ rules: [{ repo: '' }] }, 'rules[0].repo must be a non-empty string'],
    [{ rules: [{ repo: '*' }, { repo: '*', onDemand: 'tdd' }] }, 'rules[1].onDemand must be an array of skill names'],
    [{ rules: [{ repo: '*', autoDiscovered: [1] }] }, 'rules[0].autoDiscovered must be an array of skill names'],
    [{ rules: [{ repo: '*', onDemnd: ['tdd'] }] }, 'rules[0] has unknown key "onDemnd"'],
    [{ onDemandSkills: ['deploy-*'] }, 'onDemandSkills holds exact names; "*" is valid only in rules'],
    [
      { projects: { 'repo:github.com/acme/web': { onDemand: ['deploy-*'] } } },
      'projects holds exact names; "*" is valid only in rules',
    ],
  ])('names the problem in an invalid file: %j', async (malformed, problem) => {
    testDirectory = await mkdtemp(join(tmpdir(), 'skill-toggle-'));
    const configPath = join(testDirectory, 'skill-toggle.json');
    await writeFile(configPath, JSON.stringify({ onDemandSkills: [], ...malformed }));

    await expect(createSkillVisibilityStore(configPath).load()).rejects
      .toThrow(problem);
  });

  it('stores global visibility under the configured Pi agent directory', () => {
    expect(resolveSkillVisibilityConfigPath('/custom/pi-agent')).toBe(
      '/custom/pi-agent/skill-toggle.json',
    );
  });
});
