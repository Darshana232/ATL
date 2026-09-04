/**
 * Loads the repo-root `.env` into process.env.
 *
 * Called by ENTRYPOINTS ONLY (server, migration runner, test setup) - never by
 * library modules. A module that reads files as a side effect of being imported
 * is impossible to test and surprising to use.
 *
 * Note: dotenv does NOT overwrite variables that are already set. Real
 * environment variables therefore win over `.env`, which is what you want -
 * production injects real secrets and never ships a `.env` file at all.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export function loadEnvFile(): void {
  // this file lives at apps/api/src/env-file.ts, so the repo root is ../../..
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, '..', '..', '..');

  loadDotenv({ path: path.join(repoRoot, '.env'), quiet: true });
}
