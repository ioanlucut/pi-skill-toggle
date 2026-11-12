const SKILL_BLOCK_PATTERN = /^  <skill>\n[\s\S]*?^  <\/skill>\n?/gm;
const SKILL_CATALOG_PATTERN =
  /<available_skills>\n([\s\S]*?)<\/available_skills>/g;
const CHARACTERS_PER_TOKEN = 4;
const SKILL_NAME_PATTERN = /<name>([^<]+)<\/name>/;
// Pi rewords its guidance between releases, so match it by place: inside Pi's `<skills>` section, or
// the paragraph right before the catalog when its first line names skills. Other instructions stay.
const EMPTY_SKILL_SECTION_PATTERN =
  /(?<=^|\n\n)<skills>\n(?:[^<\n][^\n]*\n|\n)*<available_skills>\n<\/available_skills>\n<\/skills>\n*/g;
const EMPTY_CATALOG_PATTERN =
  /(?<=^|\n\n)(?:[^\n]*skill[^\n]*\n(?:[^\n]+\n)*\n)?<available_skills>\n<\/available_skills>\n*/gi;

export function skillCatalogNames(systemPrompt: string): Set<string> {
  const names = new Set<string>();
  for (const catalog of systemPrompt.matchAll(SKILL_CATALOG_PATTERN)) {
    for (const block of catalog[1].matchAll(SKILL_BLOCK_PATTERN)) {
      const name = block[0].match(SKILL_NAME_PATTERN)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}

export function filterSkillCatalog(
  systemPrompt: string,
  onDemandSkillNames: ReadonlySet<string>,
): string {
  const filteredPrompt = systemPrompt.replace(
    SKILL_CATALOG_PATTERN,
    (catalog) =>
      catalog.replace(
        SKILL_BLOCK_PATTERN,
        (skillBlock) => {
          const skillName = skillBlock.match(SKILL_NAME_PATTERN)?.[1];
          return skillName && onDemandSkillNames.has(skillName)
            ? ''
            : skillBlock;
        },
      ),
  );

  return filteredPrompt
    .replace(EMPTY_SKILL_SECTION_PATTERN, '')
    .replace(EMPTY_CATALOG_PATTERN, '');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function estimateSkillCatalogTokens(skill: {
  name: string;
  description?: string;
  filePath?: string;
}): number {
  const block = [
    '  <skill>',
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description ?? '')}</description>`,
    `    <location>${escapeXml(skill.filePath ?? '')}</location>`,
    '  </skill>',
  ].join('\n');
  return Math.ceil(block.length / CHARACTERS_PER_TOKEN);
}
