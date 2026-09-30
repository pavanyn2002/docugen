import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Fixture projects are inert sample code, never executed or type-checked.
    exclude: ['node_modules/**', 'dist/**', 'tests/fixtures/**'],
    environment: 'node',
    // Native parser bindings and Mermaid rendering are memory-heavy when every
    // logical CPU gets a worker. A small fixed pool is faster and avoids
    // intermittent Windows worker stalls in the full verification run.
    maxWorkers: 4,
    // Repository integration tests spawn Git repeatedly; shared Windows runners
    // can exceed Vitest's five-second default under concurrent fixture setup.
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
