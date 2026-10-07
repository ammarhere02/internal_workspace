import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// A unique workspace slug per run keeps request tests isolated from dev data (and from each other).
// It must be set here, before app.module.ts is imported, because ConfigModule reads process.env at import time.
const runSlug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

process.env.E2E_RUN_SLUG = runSlug; // read by test/global-teardown.ts to clean up this run's workspace only

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globalSetup: ['./test/global-teardown.ts'],
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: { WORKSPACE_SLUG: runSlug, OUTBOX_RELAY_ENABLED: 'false', AUTH_MODE: 'dev' }, // request tests use the seeded dev identities regardless of the .env sign-in mode // relay is exercised explicitly in relay.e2e-spec.ts
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
