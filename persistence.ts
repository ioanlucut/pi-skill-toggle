import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  return undefined;
}

async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    missing(error);
    if ((await lstat(path).catch(missing))?.isSymbolicLink()) {
      throw new Error(`Refusing to replace dangling symlink: ${path}`);
    }
    return join(await realpath(dirname(path)), basename(path));
  }
}

export async function writeSettingsFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const target = await resolveTarget(path);
  const mode = (await stat(target).catch(missing))?.mode ?? 0o600;
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.chmod(mode & 0o777);
      // Durable before rename: power loss must not leave an empty file.
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
