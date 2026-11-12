import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { writeSettingsFile } from './persistence.ts';

export type ProjectSkillOverrides = {
  onDemand: string[];
  autoDiscovered: string[];
};

export type SkillToggleRule = {
  repo: string;
  onDemand?: string[];
  autoDiscovered?: string[];
};

export type SkillToggleConfig = {
  $schema?: string;
  version?: 1;
  onDemandSkills: string[];
  projects: Record<string, ProjectSkillOverrides>;
  rules?: SkillToggleRule[];
};

export interface SkillVisibilityStore {
  load(): Promise<SkillToggleConfig>;
  save(config: SkillToggleConfig): Promise<void>;
  update(
    change: (config: SkillToggleConfig) => void | Promise<void>,
  ): Promise<SkillToggleConfig>;
}

function isSkillNameArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((skillName) => typeof skillName === 'string')
  );
}

function parseProjects(
  value: unknown,
): Record<string, ProjectSkillOverrides> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Skill toggle projects must be an object of override lists',
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, overrides]) => {
      if (
        !key || !overrides || typeof overrides !== 'object' ||
        Array.isArray(overrides)
      ) {
        throw new Error(
          'Skill toggle projects must contain named override objects',
        );
      }
      const { onDemand = [], autoDiscovered = [] } = overrides as {
        onDemand?: unknown;
        autoDiscovered?: unknown;
      };
      if (!isSkillNameArray(onDemand) || !isSkillNameArray(autoDiscovered)) {
        throw new Error(
          'Skill toggle projects must contain onDemand and autoDiscovered string arrays',
        );
      }
      return [key, { onDemand, autoDiscovered }];
    }),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const RULE_KEYS = new Set(['repo', 'onDemand', 'autoDiscovered']);

function parseRules(value: unknown): SkillToggleRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('Skill toggle rules must be an array');
  }
  return value.map((rule: unknown, index) => {
    const at = `Skill toggle rules[${index}]`;
    if (!isObject(rule)) throw new Error(`${at} must be an object`);
    const unknownKey = Object.keys(rule).find((key) => !RULE_KEYS.has(key));
    if (unknownKey) throw new Error(`${at} has unknown key "${unknownKey}"`);
    if (typeof rule.repo !== 'string' || !rule.repo) {
      throw new Error(`${at}.repo must be a non-empty string`);
    }
    for (const key of ['onDemand', 'autoDiscovered'] as const) {
      if (rule[key] !== undefined && !isSkillNameArray(rule[key])) {
        throw new Error(`${at}.${key} must be an array of skill names`);
      }
    }
    return rule as SkillToggleRule;
  });
}

function rejectWildcards(key: string, names: string[]): void {
  if (names.some((name) => name.includes('*'))) {
    throw new Error(
      `Skill toggle ${key} holds exact names; "*" is valid only in rules`,
    );
  }
}

function parseConfig(contents: string): SkillToggleConfig {
  const config: unknown = JSON.parse(contents);
  if (!isObject(config)) {
    throw new Error('Skill toggle config must contain an onDemandSkills array');
  }

  const { $schema, version, onDemandSkills } = config;
  if (version !== undefined && version !== 1) {
    throw new Error('Skill toggle version must be 1');
  }
  if ($schema !== undefined && typeof $schema !== 'string') {
    throw new Error('Skill toggle $schema must be a string');
  }
  if (!isSkillNameArray(onDemandSkills)) {
    throw new Error('Skill toggle config must contain an onDemandSkills array');
  }
  rejectWildcards('onDemandSkills', onDemandSkills);
  const projects = parseProjects(config.projects);
  rejectWildcards(
    'projects',
    Object.values(projects).flatMap((lists) => [
      ...lists.onDemand,
      ...lists.autoDiscovered,
    ]),
  );
  const rules = parseRules(config.rules);

  // Keep optional keys absent when the file has none, so a save adds nothing the user did not write.
  return {
    ...($schema === undefined ? {} : { $schema }),
    ...(version === undefined ? {} : { version }),
    onDemandSkills,
    projects,
    ...(rules === undefined ? {} : { rules }),
  };
}

export function resolveSkillVisibilityConfigPath(
  agentDirectory = getAgentDir(),
): string {
  return join(agentDirectory, 'skill-toggle.json');
}

function omitEmptyProjects(config: SkillToggleConfig): SkillToggleConfig {
  return {
    ...config,
    projects: Object.fromEntries(
      Object.entries(config.projects).filter(
        ([, overrides]) =>
          overrides.onDemand.length > 0 || overrides.autoDiscovered.length > 0,
      ),
    ),
  };
}

export function createSkillVisibilityStore(
  configPath: string,
): SkillVisibilityStore {
  async function load(): Promise<SkillToggleConfig> {
    try {
      return parseConfig(await readFile(configPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { onDemandSkills: [], projects: {} };
      }
      throw error;
    }
  }

  return {
    load,
    async save(config) {
      await writeSettingsFile(configPath, omitEmptyProjects(config));
    },
    async update(change) {
      // Reread right before the write, so another session's earlier change is kept; no lock, so two
      // writes in the same instant can lose one (the atomic rename keeps the file whole).
      const config = await load();
      const before = JSON.stringify(config);
      await change(config);
      const next = omitEmptyProjects(config);
      if (JSON.stringify(next) !== before) {
        await writeSettingsFile(configPath, next);
      }
      return next;
    },
  };
}
