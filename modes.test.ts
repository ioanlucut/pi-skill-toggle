import { describe, expect, it } from 'vitest';
import { resolveSkillMode } from './modes.ts';

describe('skill mode resolution', () => {
  it('defaults to auto-discovered', () => {
    expect(
      resolveSkillMode('tdd', { globalOnDemand: new Set() }),
    ).toEqual({ onDemand: false });
  });

  it('applies the global on-demand selection', () => {
    expect(
      resolveSkillMode('tdd', { globalOnDemand: new Set(['tdd']) }),
    ).toEqual({ onDemand: true, source: 'global' });
  });

  it('lets an explicit project on-demand override win over global auto', () => {
    expect(
      resolveSkillMode('tdd', {
        globalOnDemand: new Set(),
        projectOverrides: { onDemand: ['tdd'], autoDiscovered: [] },
      }),
    ).toEqual({ onDemand: true, source: 'project' });
  });

  it('lets an explicit project auto override win over global on-demand', () => {
    expect(
      resolveSkillMode('tdd', {
        globalOnDemand: new Set(['tdd']),
        projectOverrides: { onDemand: [], autoDiscovered: ['tdd'] },
      }),
    ).toEqual({ onDemand: false, source: 'project' });
  });
});

describe('repository rules', () => {
  const repository = 'repo:github.com/acme/web';
  const rule = (repo: string, lists: { onDemand?: string[]; autoDiscovered?: string[] }) => ({ repo, ...lists });

  it.each([
    ['repository override beats a matching rule', {
      projectOverrides: { onDemand: [], autoDiscovered: ['tdd'] },
      rules: [rule('github.com/acme/*', { onDemand: ['tdd'] })],
    }, { onDemand: false, source: 'project' }],
    ['matching rule beats the global list', {
      globalOnDemand: new Set(['tdd']),
      rules: [rule('github.com/acme/web', { autoDiscovered: ['tdd'] })],
    }, { onDemand: false, source: 'rule', pattern: 'github.com/acme/web' }],
    ['the last matching rule wins', {
      rules: [
        rule('github.com/*', { onDemand: ['tdd'] }),
        rule('github.com/acme/*', { autoDiscovered: ['tdd'] }),
        rule('github.com/other/*', { onDemand: ['tdd'] }),
      ],
    }, { onDemand: false, source: 'rule', pattern: 'github.com/acme/*' }],
    ['a wildcard skill name matches a family', {
      rules: [rule('*', { onDemand: ['deploy-*'] })],
    }, { onDemand: true, source: 'rule', pattern: '*' }, 'deploy-build'],
    ['a rule for another repository does not apply', {
      globalOnDemand: new Set(['tdd']),
      rules: [rule('github.com/other/*', { autoDiscovered: ['tdd'] })],
    }, { onDemand: true, source: 'global' }],
    ['a skill outside the rule lists falls through', {
      rules: [rule('github.com/acme/*', { onDemand: ['deploy-*'] })],
    }, { onDemand: false }],
    ['a pattern must match the whole identity', {
      rules: [rule('github.com/acme', { onDemand: ['tdd'] })],
    }, { onDemand: false }],
    ['dots in a pattern are literal', {
      rules: [rule('github.com/acme/we.', { onDemand: ['tdd'] })],
    }, { onDemand: false }],
  ] as const)('%s', (_name, inputs, expected, skill: string = 'tdd') => {
    expect(resolveSkillMode(skill, {
      globalOnDemand: new Set(),
      repository,
      ...inputs,
    } as never)).toEqual(expected);
  });

  it.each(['git:/work/local/.git', '/tmp/not-a-repository', undefined])(
    'never applies rules to a repository without a network origin: %s',
    (localRepository) => {
      expect(resolveSkillMode('tdd', {
        globalOnDemand: new Set(),
        repository: localRepository,
        rules: [{ repo: '*', onDemand: ['*'] }],
      })).toEqual({ onDemand: false });
    },
  );
});
