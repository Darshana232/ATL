/**
 * Vitest setup, run once before the test suite.
 *
 * Tests are an entrypoint, so this is one of the few places allowed to load
 * the .env file. Vitest sets NODE_ENV=test itself, and dotenv never overwrites
 * an existing variable, so NODE_ENV stays 'test' even though .env says
 * 'development' - which is exactly why the logger skips the pino-pretty
 * transport (and its worker thread) during tests.
 */
import { loadEnvFile } from './env-file.js';

loadEnvFile();
