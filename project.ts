import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ProjectSkillPolicy = {
  root: string;
  key: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolve(path);
    }
    throw error;
  }
}

async function findProjectRoot(workingDirectory: string): Promise<string> {
  const fallbackRoot = await canonicalPath(workingDirectory);
  let candidate = fallbackRoot;
  while (true) {
    if (await pathExists(join(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return fallbackRoot;
    candidate = parent;
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    // A parent process's Git context must not redirect identity lookups to another repo.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    );
    return (await exec('git', ['-C', cwd, ...args], { env, timeout: 2000 }))
      .stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Share transport variants, but keep different hosts, owners, forks, and nonstandard ports separate. */
export function repositoryKey(remote: string): string | undefined {
  let host: string;
  let path: string;
  if (remote.includes('://')) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) {
      return undefined;
    }
    host = url.hostname.toLowerCase();
    if (url.port && !(url.protocol === 'ssh:' && url.port === '22')) {
      host += `:${url.port}`;
    }
    path = url.pathname;
  } else {
    const match = remote.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
    if (!match) return undefined;
    [, host, path] = match;
    host = host.toLowerCase();
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!path) return undefined;
  if (host === 'github.com') path = path.toLowerCase();
  return `repo:${host}/${path}`;
}

export async function resolveProjectSkillPolicy(
  workingDirectory: string,
): Promise<ProjectSkillPolicy> {
  const root = await findProjectRoot(workingDirectory);
  let key = root;
  if (await pathExists(join(root, '.git'))) {
    const [remote, commonDirectory] = await Promise.all([
      git(root, ['remote', 'get-url', 'origin']),
      git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    key = (remote && repositoryKey(remote)) ||
      (commonDirectory
        ? `git:${await canonicalPath(resolve(root, commonDirectory))}`
        : root);
  }
  return { root, key };
}
