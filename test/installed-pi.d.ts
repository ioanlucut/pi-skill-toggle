/** Directory of the pi-coding-agent package behind the `pi` binary on PATH, or PI_PACKAGE_DIR. */
export function resolveInstalledPiDirectory(): string;
/** Vite aliases that bind Pi's runtime packages to the installed pi. */
export function installedPiAliases(): Record<string, string>;
