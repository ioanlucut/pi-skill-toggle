import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SourceInfo,
} from '@earendil-works/pi-coding-agent';
import {
  estimateSkillCatalogTokens,
  filterSkillCatalog,
} from './catalog.ts';
import { resolveSkillOwner } from './owners.ts';
import {
  resolveSkillMode,
  SKILL_ACTIONS,
  type SkillAction,
  type SkillMode,
  type SkillScope,
} from './modes.ts';
import { resolveProjectSkillPolicy } from './project.ts';
import { createSkillSelector } from './selector.ts';
import {
  createSkillVisibilityStore,
  resolveSkillVisibilityConfigPath,
  type SkillToggleConfig,
  type SkillVisibilityStore,
} from './store.ts';

export type { SkillToggleConfig, SkillVisibilityStore } from './store.ts';

const USAGE_HELP =
  'Use: /skill-toggle [list] | on|off <skill> [--global] | reset <skill>';

const ACTIONS = new Map<string, SkillAction>(Object.entries(SKILL_ACTIONS));

export function describeSource(mode: SkillMode): string {
  if (mode.source === 'project') return 'repository';
  if (mode.source === 'rule') return `rule ${mode.pattern}`;
  return mode.source ?? 'default';
}

const onOff = (mode: SkillMode) => (mode.onDemand ? 'off' : 'on');

/** Print and JSON modes have no UI, so `notify` would drop the text. */
function report(
  ctx: ExtensionContext,
  message: string,
  level: 'info' | 'warning' | 'error',
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else if (level === 'info') console.log(message);
  else console.error(message);
}

type SkillInfo = {
  name: string;
  description?: string;
  filePath?: string;
  sourceInfo?: SourceInfo;
  disableModelInvocation?: boolean;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toggleableSkills(ctx: ExtensionCommandContext): SkillInfo[] {
  return (ctx.getSystemPromptOptions().skills ?? []).filter((skill) =>
    !skill.disableModelInvocation
  );
}

export function registerSkillToggle(
  pi: ExtensionAPI,
  store: SkillVisibilityStore,
): void {
  let config: SkillToggleConfig = { onDemandSkills: [], projects: {} };
  let projectKey: string | undefined;

  function skillModeInputs() {
    return {
      globalOnDemand: new Set(config.onDemandSkills),
      projectOverrides: projectKey ? config.projects[projectKey] : undefined,
      repository: projectKey,
      rules: config.rules,
    };
  }

  // Rules hold wildcards, so the loaded skill names are candidates too.
  function effectiveOnDemandNames(loadedNames: string[]): Set<string> {
    const inputs = skillModeInputs();
    const candidates = new Set([
      ...loadedNames,
      ...inputs.globalOnDemand,
      ...(inputs.projectOverrides?.onDemand ?? []),
    ]);
    return new Set(
      [...candidates].filter((name) => resolveSkillMode(name, inputs).onDemand),
    );
  }

  async function refreshConfig(): Promise<void> {
    config = await store.load();
  }

  async function applyAction(
    skillName: string,
    scope: SkillScope,
    action: SkillAction,
  ): Promise<void> {
    config = await store.update((current) => {
      const withoutSkill = (names: string[]) =>
        names.filter((name) => name !== skillName);
      if (scope === 'global') {
        current.onDemandSkills = action === 'on-demand'
          ? [...new Set([...current.onDemandSkills, skillName])].sort()
          : withoutSkill(current.onDemandSkills);
        return;
      }
      if (!projectKey) {
        throw new Error('Repository scope is unavailable; run /reload first.');
      }
      if (action === 'clear' && !current.projects[projectKey]) return;
      const overrides = current.projects[projectKey] ??= {
        onDemand: [],
        autoDiscovered: [],
      };
      overrides.onDemand = withoutSkill(overrides.onDemand);
      overrides.autoDiscovered = withoutSkill(overrides.autoDiscovered);
      if (action === 'on-demand') overrides.onDemand.push(skillName);
      if (action === 'auto-discovered') {
        overrides.autoDiscovered.push(skillName);
      }
      overrides.onDemand.sort();
      overrides.autoDiscovered.sort();
    });
  }

  function listSkills(ctx: ExtensionCommandContext): string {
    const skills = toggleableSkills(ctx).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    const width = Math.max(0, ...skills.map((skill) => skill.name.length));
    return [
      `Skills for ${projectKey ?? 'an unavailable repository'}:`,
      ...skills.map((skill) => {
        const mode = resolveSkillMode(skill.name, skillModeInputs());
        return `${skill.name.padEnd(width)}  ${onOff(mode).padEnd(3)}  ${
          describeSource(mode)
        }`;
      }),
    ].join('\n');
  }

  function completeArguments(prefix: string) {
    const words = prefix.trimStart().split(/\s+/);
    const [action, skill, flag] = words;
    let values: string[] = [];
    if (words.length === 1) {
      values = ['on ', 'off ', 'reset ', 'list'].filter((value) =>
        value.startsWith(action) && value !== action
      );
    } else if (words.length === 2 && ACTIONS.has(action)) {
      values = pi.getCommands()
        .filter((command) => command.source === 'skill')
        .map((command) => command.name.slice('skill:'.length))
        .filter((name) => name.startsWith(skill))
        .sort()
        .map((name) => `${action} ${name} `);
    } else if (
      words.length === 3 && (action === 'on' || action === 'off') &&
      '--global'.startsWith(flag) && flag !== '--global'
    ) {
      values = [`${action} ${skill} --global`];
    }
    return values.length
      ? values.map((value) => ({ value, label: value.trim() }))
      : null;
  }

  async function openSelector(ctx: ExtensionCommandContext): Promise<void> {
    const skills = toggleableSkills(ctx).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    const owners = new Map(
      await Promise.all(
        skills.map(async (skill) =>
          [skill.name, await resolveSkillOwner(skill)] as const
        ),
      ),
    );
    const totalCatalogTokens = skills.reduce(
      (total, skill) => total + estimateSkillCatalogTokens(skill),
      0,
    );
    await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
      createSkillSelector({
        project: projectKey ?? 'Repository unavailable — reload to retry',
        theme,
        maxVisibleRows: Math.max(
          3,
          Math.min(10, (tui.terminal?.rows ?? 24) - 18),
        ),
        close: () => done(undefined),
        requestRender: () => tui.requestRender(),
        matches: (data, action) => keybindings.matches(data, action),
        change: applyAction,
        rows: () =>
          skills.map((skill) => {
            const mode = resolveSkillMode(skill.name, skillModeInputs());
            const tokens = estimateSkillCatalogTokens(skill);
            const share = totalCatalogTokens > 0
              ? `${((tokens / totalCatalogTokens) * 100).toFixed(1)}%`
              : '0.0%';
            return {
              name: skill.name,
              description: skill.description,
              owner: owners.get(skill.name) ?? 'Unknown',
              onDemand: mode.onDemand,
              globalOnDemand: config.onDemandSkills.includes(skill.name),
              tokens,
              source: describeSource(mode),
              detail: `~${tokens} tok · ${share}`,
            };
          }),
      })
    );
  }

  pi.registerCommand('skill-toggle', {
    description:
      'Turn skills on or off for the model, per repository or --global; no arguments opens the picker',
    getArgumentCompletions: completeArguments,
    handler: async (args, ctx) => {
      try {
        await refreshConfig();
        const words = args.trim().split(/\s+/).filter(Boolean);
        const [word, ...rest] = words;
        if (!word || (word === 'list' && rest.length === 0)) {
          if (word || ctx.mode !== 'tui') report(ctx, listSkills(ctx), 'info');
          else await openSelector(ctx);
          return;
        }
        const globalFlagCount = rest.filter((part) => part === '--global').length;
        const names = rest.filter((part) => part !== '--global');
        const action = ACTIONS.get(word);
        if (
          !action || names.length !== 1 || globalFlagCount > 1 ||
          (globalFlagCount && action === 'clear')
        ) {
          report(ctx, USAGE_HELP, 'error');
          return;
        }
        const [skillName] = names;
        const declaredSkill = ctx.getSystemPromptOptions().skills?.find(
          (skill) => skill.name === skillName,
        );
        if (declaredSkill?.disableModelInvocation && action !== 'clear') {
          report(
            ctx,
            `${skillName} is off by its own frontmatter (disable-model-invocation) and cannot be changed here.`,
            'warning',
          );
          return;
        }
        const overrides = projectKey ? config.projects[projectKey] : undefined;
        const isStored = config.onDemandSkills.includes(skillName) ||
          overrides?.onDemand.includes(skillName) ||
          overrides?.autoDiscovered.includes(skillName);
        if (
          !toggleableSkills(ctx).some((skill) => skill.name === skillName) &&
          !isStored
        ) {
          report(ctx, `Unknown skill: ${skillName}`, 'error');
          return;
        }
        await applyAction(skillName, globalFlagCount ? 'global' : 'project', action);
        const resolved = resolveSkillMode(skillName, skillModeInputs());
        const effective = `${onOff(resolved)} (${describeSource(resolved)})`;
        if (action === 'clear') {
          report(ctx, `${skillName} repository override removed; now ${effective}`, 'info');
        } else if (!globalFlagCount) {
          report(ctx, `${skillName} is now ${word} for ${projectKey}`, 'info');
        } else if (word !== onOff(resolved)) {
          report(
            ctx,
            `${skillName} is now ${word} globally but stays ${onOff(resolved)} here (${
              describeSource(resolved)
            })`,
            'info',
          );
        } else report(ctx, `${skillName} is now ${word} globally`, 'info');
      } catch (error) {
        report(
          ctx,
          `Skill toggle failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        );
      }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const projectPolicy = await resolveProjectSkillPolicy(ctx.cwd);
    projectKey = projectPolicy.key;
    try {
      await refreshConfig();
    } catch (error) {
      report(
        ctx,
        `Skill settings could not be loaded (${errorMessage(error)}); fix the configuration and run /reload.`,
        'warning',
      );
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      await refreshConfig();
    } catch (error) {
      report(
        ctx,
        `Skill toggle settings could not be refreshed (${errorMessage(error)}); using the last loaded selections.`,
        'warning',
      );
    }
    const options = event.systemPromptOptions;
    const onDemandNames = effectiveOnDemandNames(options.skills.map((skill) => skill.name));
    // Keep Pi's recorded prompt and later tool/prompt updates in sync with the outgoing catalog.
    options.skills = options.skills.filter((skill) => !onDemandNames.has(skill.name));
    if (options.forceSystemPrompt !== undefined) {
      options.forceSystemPrompt = filterSkillCatalog(options.forceSystemPrompt, onDemandNames);
    }
  });
}

export default function xSkillToggleExtension(pi: ExtensionAPI): void {
  registerSkillToggle(
    pi,
    createSkillVisibilityStore(resolveSkillVisibilityConfigPath()),
  );
}
