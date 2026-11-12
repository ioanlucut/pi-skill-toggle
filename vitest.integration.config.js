import { defineConfig } from 'vitest/config';
import { installedPiAliases } from './test/installed-pi.js';

// Runs the extension inside real Pi sessions from the `pi` on PATH; no coverage on purpose.
export default defineConfig({
  resolve: { alias: installedPiAliases() },
  test: {
    globals: true,
    testTimeout: 20_000,
    include: ['*.integration.test.ts'],
  },
});
