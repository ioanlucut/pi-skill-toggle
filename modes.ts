import type { ProjectSkillOverrides, SkillToggleRule } from './store.ts';

export type SkillScope = 'project' | 'global';
export type SkillAction = 'auto-discovered' | 'on-demand' | 'clear';

export const SKILL_ACTIONS = {
  on: 'auto-discovered',
  off: 'on-demand',
  reset: 'clear',
} as const satisfies Record<string, SkillAction>;

export type SkillModeSource = 'project' | 'rule' | 'global';

export type SkillMode = {
  onDemand: boolean;
  source?: SkillModeSource;
  pattern?: string;
};

export type SkillModeInputs = {
  globalOnDemand: ReadonlySet<string>;
  projectOverrides?: ProjectSkillOverrides;
  repository?: string;
  rules?: readonly SkillToggleRule[];
};

const REPOSITORY_PREFIX = 'repo:';

export function matchesPattern(pattern: string, value: string): boolean {
  const source = pattern.split('*')
    .map((part) => part.replace(/[\\^$.+?()[\]{}|]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

function resolveRuleMode(
  skillName: string,
  repository: string | undefined,
  rules: readonly SkillToggleRule[],
): SkillMode | undefined {
  if (!repository?.startsWith(REPOSITORY_PREFIX)) return undefined;
  const identity = repository.slice(REPOSITORY_PREFIX.length);
  // Later rules win, so the first match from the end decides.
  for (const rule of [...rules].reverse()) {
    if (!matchesPattern(rule.repo, identity)) continue;
    const listed = (names?: string[]) =>
      names?.some((name) => matchesPattern(name, skillName)) ?? false;
    // Within one rule, on-demand wins over auto-discovered, as for a repository override.
    if (listed(rule.onDemand)) return { onDemand: true, source: 'rule', pattern: rule.repo };
    if (listed(rule.autoDiscovered)) return { onDemand: false, source: 'rule', pattern: rule.repo };
  }
  return undefined;
}

export function resolveSkillMode(
  skillName: string,
  { globalOnDemand, projectOverrides, repository, rules = [] }: SkillModeInputs,
): SkillMode {
  if (projectOverrides?.onDemand.includes(skillName)) {
    return { onDemand: true, source: 'project' };
  }
  if (projectOverrides?.autoDiscovered.includes(skillName)) {
    return { onDemand: false, source: 'project' };
  }
  const ruleMode = resolveRuleMode(skillName, repository, rules);
  if (ruleMode) return ruleMode;
  if (globalOnDemand.has(skillName)) {
    return { onDemand: true, source: 'global' };
  }
  return { onDemand: false };
}
