import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';

const PACKAGE_NAME = '@earendil-works/pi-coding-agent';

function packageNameAt(directory) {
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest)) return undefined;
  return JSON.parse(readFileSync(manifest, 'utf8')).name;
}

/** Locate the pi-coding-agent package behind the `pi` binary on PATH, so tests run against the pi that is actually installed. */
export function resolveInstalledPiDirectory() {
  const override = process.env.PI_PACKAGE_DIR;
  if (override) return override;
  // `npm run` prepends node_modules/.bin, where the workspace's own pi dependency also installs a `pi`; skip those
  // entries so the tests bind to the pi the user actually runs.
  const searchPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => !entry.includes(`${sep}node_modules${sep}.bin`))
    .join(delimiter);
  let binary;
  try {
    binary = execFileSync('which', ['pi'], { encoding: 'utf8', env: { ...process.env, PATH: searchPath } }).trim();
  } catch {
    throw new Error('pi is not on PATH; install pi or set PI_PACKAGE_DIR.');
  }
  let directory = dirname(realpathSync(binary));
  while (directory !== dirname(directory)) {
    if (packageNameAt(directory) === PACKAGE_NAME) return directory;
    directory = dirname(directory);
  }
  throw new Error(`Could not find ${PACKAGE_NAME} above ${binary}.`);
}

/** Find a package the way Node does from `directory`: its own node_modules first, then each parent's (nested or hoisted). */
function resolvePackageFrom(directory, name) {
  for (let current = directory; current !== dirname(current); current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Could not find ${name} from ${directory}.`);
}

/** Alias map so tests resolve pi's runtime packages from the installed pi instead of a local copy. */
export function installedPiAliases() {
  const piDirectory = resolveInstalledPiDirectory();
  return {
    [PACKAGE_NAME]: piDirectory,
    '@earendil-works/pi-ai': resolvePackageFrom(piDirectory, '@earendil-works/pi-ai'),
  };
}
