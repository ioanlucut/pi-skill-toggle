import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSkillVisibilityConfigPath } from './store.ts';

afterEach(() => vi.unstubAllEnvs());

describe('Pi agent directory', () => {
  it.each([undefined, '~/alternate-pi-agent', 'relative/pi-agent', '/custom/pi-agent'])(
    'uses Pi resolution for %s', (agentDirectory) => {
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

      expect(resolveSkillVisibilityConfigPath()).toBe(join(getAgentDir(), 'skill-toggle.json'));
    },
  );

  it('expands the home alias in the environment directory', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '~/alternate-pi-agent');

    expect(resolveSkillVisibilityConfigPath()).toBe(join(homedir(), 'alternate-pi-agent', 'skill-toggle.json'));
  });
});
