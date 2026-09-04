import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    /** Loads the repo-root .env before any test runs. */
    setupFiles: ['./src/test-setup.ts'],

    /**
     * Integration tests share ONE local PostgreSQL database. Running test
     * files in parallel would let them interfere with each other's rows -
     * a classic source of tests that pass alone and fail together.
     *
     * Tests within a single file still run in order, which is what we want.
     * Phase 12 can revisit this with a database-per-worker strategy if the
     * suite gets slow.
     */
    fileParallelism: false,
  },
});
