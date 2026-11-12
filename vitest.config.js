import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests resolve Pi from the locked devDependencies, so they run without a Pi install.
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 20_000, // real Git repositories and Node writers start subprocesses
    include: ['*.test.ts'],
    // Pi loads the extension through its own loader in integration tests, which would double-count V8 coverage.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
