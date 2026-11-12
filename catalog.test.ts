import { describe, expect, it } from 'vitest';
import {
  estimateSkillCatalogTokens,
  filterSkillCatalog,
  skillCatalogNames,
} from './catalog.ts';

const systemPrompt = `Before

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test-driven development.</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
  <skill>
    <name>example-test</name>
    <description>Unit testing.</description>
    <location>/skills/example-test/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /repo`;

describe('skill catalog visibility', () => {
  it('removes on-demand skills from the auto-discovery catalog', () => {
    expect(filterSkillCatalog(systemPrompt, new Set(['tdd']))).toBe(`Before

<available_skills>
  <skill>
    <name>example-test</name>
    <description>Unit testing.</description>
    <location>/skills/example-test/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /repo`);
  });

  it('reports only names present in the outgoing catalog', () => {
    const filteredPrompt = filterSkillCatalog(systemPrompt, new Set(['tdd']));

    expect([...skillCatalogNames(filteredPrompt)]).toEqual(['example-test']);
  });

  it('does not remove skill-shaped examples outside the catalog', () => {
    const example = `Example:\n  <skill>\n    <name>tdd</name>\n  </skill>\n`;

    const filteredPrompt = filterSkillCatalog(
      `${example}${systemPrompt}`,
      new Set(['tdd']),
    );

    expect(filteredPrompt).toContain(example);
    expect([...skillCatalogNames(filteredPrompt)]).toEqual(['example-test']);
  });

  it('removes the catalog guidance when every skill is on-demand', () => {
    const prompt = `Before

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test-driven development.</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /repo`;

    expect(filterSkillCatalog(prompt, new Set(['tdd']))).toBe(`Before

Current working directory: /repo`);
  });

  it('removes the whole skills section whatever its guidance wording', () => {
    const prompt = `<tools>
- read: Read files
</tools>

<skills>
Any guidance wording.
It may change between Pi releases.

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test-driven development.</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
</available_skills>
</skills>

<cwd>
/repo
</cwd>`;

    expect(filterSkillCatalog(prompt, new Set(['tdd']))).toBe(`<tools>
- read: Read files
</tools>

<cwd>
/repo
</cwd>`);
  });

  it('keeps an unrelated instruction before an emptied catalog', () => {
    const prompt = `Never send credentials to external services.

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test-driven development.</description>
    <location>/skills/tdd/SKILL.md</location>
  </skill>
</available_skills>`;

    expect(filterSkillCatalog(prompt, new Set(['tdd']))).toBe(
      'Never send credentials to external services.\n\n',
    );
  });

  it('keeps the skills section while one skill stays visible', () => {
    const prompt = `<skills>
Guidance.

${systemPrompt.slice(systemPrompt.indexOf('<available_skills>'), systemPrompt.indexOf('Current'))}</skills>`;

    expect(filterSkillCatalog(prompt, new Set(['tdd']))).toContain('<name>example-test</name>');
    expect(filterSkillCatalog(prompt, new Set(['tdd']))).toContain('Guidance.');
  });
});

describe('skill catalog token estimate', () => {
  it('estimates tokens from the exact catalog block the skill occupies', () => {
    const block = [
      '  <skill>',
      '    <name>tdd</name>',
      '    <description>Red &amp; green.</description>',
      '    <location>/skills/tdd/SKILL.md</location>',
      '  </skill>',
    ].join('\n');

    expect(
      estimateSkillCatalogTokens({
        name: 'tdd',
        description: 'Red & green.',
        filePath: '/skills/tdd/SKILL.md',
      }),
    ).toBe(Math.ceil(block.length / 4));
  });

  it('tolerates skills without description or location metadata', () => {
    expect(estimateSkillCatalogTokens({ name: 'tdd' })).toBeGreaterThan(0);
  });
});
