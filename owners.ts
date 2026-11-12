import { readFile } from 'node:fs/promises';
import {
  parseFrontmatter,
  type SourceInfo,
} from '@earendil-works/pi-coding-agent';

async function declaredAuthor(filePath: string): Promise<string | undefined> {
  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
      await readFile(filePath, 'utf8'),
    );
    const metadata = frontmatter.metadata;
    const author = frontmatter.author ??
      (metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>).author
        : undefined);
    return typeof author === 'string' && author.trim() ? author.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Declared `author`, else where Pi loaded the skill from: the package source, or `user`/`project`. */
export async function resolveSkillOwner(
  skill: { filePath?: string; sourceInfo?: SourceInfo },
): Promise<string> {
  const author = skill.filePath && await declaredAuthor(skill.filePath);
  if (author) return author;
  const info = skill.sourceInfo;
  if (!info) return 'Unknown';
  return info.origin === 'package' ? info.source : info.scope;
}
