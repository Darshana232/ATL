/**
 * MCP server - the agent tools, over the Model Context Protocol.
 *
 *   npm run mcp -w apps/api
 *
 * Speaks MCP over stdio, so any MCP client (Claude Desktop, an IDE, another
 * agent framework) can drive this agent's tools.
 *
 * ================== IT REUSES THE SAME TOOL REGISTRY ==================
 * `TOOL_DEFINITIONS`, `grantedToolNames`, `authorizeToolCall` and `executeTool`
 * are the SAME functions the in-process runtime uses. This file adds a
 * transport and nothing else.
 *
 * A second implementation of "which tools may this agent call?" is how a
 * security boundary develops a hole: the two copies drift, and the one nobody
 * reviewed is the one that is wrong. So the scope check below is a call into
 * shared code, not a reimplementation.
 * ======================================================================
 *
 * The MCP client is Zone 1 - untrusted. Every payment still goes through a
 * signed HTTP call to the trusted zone, and still needs a voucher.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadEnvFile } from '../env-file.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createPool } from '../db/pool.js';
import { DatabaseCatalogProvider } from '../providers/catalog.js';
import { loadForAuthorization } from '../repositories/mandate.js';
import {
  authorizeToolCall, grantedToolNames, offeredTools, TOOL_REFUSAL_MESSAGE,
} from '../agent/tools.js';
import { executeTool, type ExecutionContext } from '../agent/executor.js';

loadEnvFile();

const KEYS_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../../.seed-keys.json',
);

interface SeedKey { agentId: string; keyId: string; privateKeyPkcs8B64: string }

/**
 * Which agent and mandate this server acts for.
 *
 * Environment, not a tool parameter. A client that could choose its own agent
 * id would be choosing its own permissions - the identity must be established
 * by the operator who starts the process, exactly as an agent's key is.
 */
const AGENT_ID = process.env.ATL_MCP_AGENT_ID ?? 'agt_grocery_shopper';
const MANDATE_ID = process.env.ATL_MCP_MANDATE_ID ?? 'mnd_weekly_groceries';
const API_BASE = process.env.ATL_API_BASE_URL ?? 'http://127.0.0.1:8080';

async function main(): Promise<void> {
  // stderr only. stdout IS the MCP transport - a stray log line there corrupts
  // the protocol stream, which presents as a baffling client-side parse error.
  const config = loadConfig({ ...process.env, LOG_LEVEL: 'fatal' });
  const logger = createLogger(config);
  const pool = createPool(config, logger);

  const keys = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as SeedKey[];
  const key = keys.find((candidate) => candidate.agentId === AGENT_ID);
  if (key === undefined) throw new Error(`no seeded key for ${AGENT_ID}; run npm run seed`);

  const loaded = await loadForAuthorization(pool, MANDATE_ID);
  if (loaded === null) throw new Error(`mandate ${MANDATE_ID} not found`);

  const context: ExecutionContext = {
    identity: {
      agentId: AGENT_ID, keyId: key.keyId, privateKeyPkcs8B64: key.privateKeyPkcs8B64,
    },
    mandateId: MANDATE_ID,
    allowedMerchantIds: loaded.version.merchantAllowlist,
    apiBaseUrl: API_BASE,
    catalog: new DatabaseCatalogProvider(pool),
    now: () => new Date(),
  };

  const server = new Server(
    { name: 'atl-india', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Re-read grants on every listing. A revoked grant must disappear
    // immediately, not when a cache expires.
    const granted = await grantedToolNames(pool, AGENT_ID);

    return {
      tools: offeredTools(granted).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object' },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const granted = await grantedToolNames(pool, AGENT_ID);

    // THE SCOPE CHECK. Shared code, and it runs even for a tool that was never
    // listed - because a client can call anything it likes.
    const authorization = authorizeToolCall(granted, request.params.name);

    if (!authorization.allowed) {
      return {
        content: [{ type: 'text' as const, text: TOOL_REFUSAL_MESSAGE }],
        isError: true,
      };
    }

    const result = await executeTool(
      context,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    );

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.content, null, 2) }],
      isError: !result.ok,
    };
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `ATL-India MCP server ready. agent=${AGENT_ID} mandate=${MANDATE_ID} api=${API_BASE}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
