import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceInfo } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it } from 'vitest';
import { resolveSkillOwner } from './owners.ts';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function origin(info: Partial<SourceInfo>): SourceInfo {
  return { path: '/skills/x/SKILL.md', source: 'auto', scope: 'user', origin: 'top-level', ...info };
}

async function skillFile(frontmatter: string): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'skill-owners-'));
  const filePath = join(directory, 'SKILL.md');
  await writeFile(filePath, `---\nname: example\n${frontmatter}---\n`);
  return filePath;
}

it.each([
  ['author: Example Maintainer\n', 'Example Maintainer'],
  ['metadata:\n  author: Nested Maintainer\n', 'Nested Maintainer'],
])('uses the declared author %j', async (frontmatter, expected) => {
  const filePath = await skillFile(frontmatter);

  expect(await resolveSkillOwner({ filePath, sourceInfo: origin({ scope: 'project' }) }))
    .toBe(expected);
});

it.each([
  [origin({ scope: 'user' }), 'user'],
  [origin({ scope: 'project' }), 'project'],
  [origin({ origin: 'package', source: 'git:github.com/example/skills' }), 'git:github.com/example/skills'],
])('falls back to the origin Pi reports: %j', async (sourceInfo, expected) => {
  const filePath = await skillFile('');

  expect(await resolveSkillOwner({ filePath, sourceInfo })).toBe(expected);
  expect(await resolveSkillOwner({ filePath: '/missing/SKILL.md', sourceInfo })).toBe(expected);
});

it('labels a skill without author or origin as unknown', async () => {
  expect(await resolveSkillOwner({})).toBe('Unknown');
});
