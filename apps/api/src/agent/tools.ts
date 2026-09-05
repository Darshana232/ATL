/**
 * The agent tool registry.
 *
 * ONE registry, ONE scope check, TWO transports (the in-process runtime and the
 * MCP server). A second implementation of "which tools may this agent call?"
 * is how a security boundary develops a hole - the two copies drift, and the
 * one nobody looked at is the one that is wrong.
 *
 * TOOL-LEVEL AUTHORIZATION IS TWO-SIDED, deliberately:
 *
 *   1. An ungranted tool is NEVER OFFERED. The model does not see it, so it
 *      cannot be tempted, and the prompt stays small.
 *   2. An ungranted tool is ALSO REFUSED IF CALLED. Because a model can invent
 *      a tool name it was never shown - and an attacker who has injected the
 *      context will absolutely tell it to.
 *
 * Only (2) is a security control. (1) is hygiene. Shipping only (1) would be a
 * classic mistake: hiding a capability is not the same as removing it.
 */
import type pg from 'pg';

/** Matches `tools.name` in migration 0002, which the FK on grants enforces. */
export type ToolName =
  | 'search_products'
  | 'get_product'
  | 'create_cart'
  | 'get_mandate'
  | 'request_authorization'
  | 'execute_payment'
  | 'get_transaction'
  | 'modify_mandate'
  | 'delete_audit_event'
  | 'export_all_users'
  | 'generate_compliance_report';

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  /** JSON Schema, so the same definition serves the LLM API and MCP. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Marks tools we expect to grant rarely and audit closely. The dashboard
   * highlights an unusual grant; Phase 9 review reads this column.
   */
  readonly sensitive: boolean;
}

const str = (description: string) => ({ type: 'string', description });

/**
 * Every tool that exists. Granting is a separate question entirely - this list
 * is the vocabulary, `agent_tool_grants` is the permission.
 *
 * The last three exist ON PURPOSE and are granted to NOBODY. A tool-level
 * authorization demo with nothing dangerous in the catalogue proves nothing:
 * there has to be something worth refusing.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'search_products',
    description:
      'Search the product catalog. Results are restricted to merchants the ' +
      'active mandate permits.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Free-text search over product names and shelves.'),
        maxPricePaise: { type: 'integer', description: 'Optional price ceiling, in paise.' },
      },
      required: [],
    },
    sensitive: false,
  },
  {
    name: 'get_product',
    description: 'Fetch one product by id.',
    inputSchema: {
      type: 'object',
      properties: { productId: str('A product id, e.g. prd_bb_atta_5kg.') },
      required: ['productId'],
    },
    sensitive: false,
  },
  {
    name: 'create_cart',
    description:
      'Build a cart from catalog items and compute its total in paise. ' +
      'Creating a cart authorises nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: str('Product id.'),
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['productId', 'quantity'],
          },
        },
      },
      required: ['items'],
    },
    sensitive: false,
  },
  {
    name: 'get_mandate',
    description: 'Read the spending mandate currently in force, including its limits.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    sensitive: false,
  },
  {
    name: 'request_authorization',
    description:
      'Ask ATL-India whether a payment is permitted. Returns a verdict with a ' +
      'per-rule breakdown, and a single-use voucher ONLY if the verdict is ' +
      'PASS or FLAG. This tool decides nothing; the deterministic policy ' +
      'engine does.',
    inputSchema: {
      type: 'object',
      properties: {
        merchantId: str('Merchant to pay.'),
        amountPaise: { type: 'integer', description: 'Amount in paise.' },
      },
      required: ['merchantId', 'amountPaise'],
    },
    sensitive: false,
  },
  {
    name: 'execute_payment',
    description:
      'Execute a payment that has ALREADY been authorized. Requires the voucher ' +
      'returned by request_authorization. Without a valid voucher this fails.',
    inputSchema: {
      type: 'object',
      properties: {
        voucher: str('The voucher token from request_authorization.'),
        merchantId: str('Must match the voucher.'),
        amountPaise: { type: 'integer', description: 'Must match the voucher.' },
      },
      required: ['voucher', 'merchantId', 'amountPaise'],
    },
    sensitive: false,
  },
  {
    name: 'get_transaction',
    description: 'Read the status of a payment this agent made.',
    inputSchema: {
      type: 'object',
      properties: { paymentId: str('A payment id.') },
      required: ['paymentId'],
    },
    sensitive: false,
  },

  /* --- Granted to nobody. Present so refusal is demonstrable. ---------- */
  {
    name: 'modify_mandate',
    description: 'Change a spending mandate.',
    inputSchema: {
      type: 'object',
      properties: { mandateId: str('Mandate to change.') },
      required: ['mandateId'],
    },
    sensitive: true,
  },
  {
    // Named to match the `tools` table exactly. An earlier draft called this
    // `delete_audit_log`, and `agent_tool_grants_tool_name_fkey` refused the
    // grant - which is precisely why that table is a reference table with a
    // foreign key rather than a hardcoded list (migration 0002). A typo in a
    // capability name is caught at insert time instead of silently granting
    // nothing.
    name: 'delete_audit_event',
    description: 'Remove audit events.',
    inputSchema: {
      type: 'object',
      properties: { before: str('ISO timestamp.') },
      required: [],
    },
    sensitive: true,
  },
  {
    name: 'export_all_users',
    description: 'Export the full user table.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    sensitive: true,
  },
  {
    name: 'generate_compliance_report',
    description: 'Produce a regulatory report.',
    inputSchema: {
      type: 'object',
      properties: { kind: str('Report type.') },
      required: ['kind'],
    },
    sensitive: true,
  },
];

const BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function toolDefinition(name: string): ToolDefinition | null {
  return BY_NAME.get(name as ToolName) ?? null;
}

/**
 * Which tools this agent is actually permitted to call.
 *
 * Read from `agent_tool_grants` on every run, not cached. A revoked grant must
 * take effect immediately - a cache here would mean a compromised agent keeps
 * a capability we already took away, for as long as the TTL.
 */
export async function grantedToolNames(
  client: pg.PoolClient | pg.Pool,
  agentId: string,
): Promise<Set<string>> {
  const result = await client.query<{ tool_name: string }>(
    `SELECT tool_name FROM agent_tool_grants WHERE agent_id = $1`,
    [agentId],
  );

  return new Set(result.rows.map((row) => row.tool_name));
}

/** The tool definitions to OFFER. Hygiene, not the security control. */
export function offeredTools(granted: ReadonlySet<string>): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => granted.has(tool.name));
}

export type ToolAuthorization =
  | { readonly allowed: true; readonly definition: ToolDefinition }
  | { readonly allowed: false; readonly reason: 'unknown_tool' | 'not_granted' };

/**
 * THE SECURITY CONTROL. Called before a tool runs, every time, whatever the
 * model was offered.
 *
 * `unknown_tool` and `not_granted` are distinguished for OUR logs and returned
 * to the model as the same refusal - a model that learns which tool names exist
 * from our error messages is a model an attacker can use to enumerate them.
 */
export function authorizeToolCall(
  granted: ReadonlySet<string>,
  name: string,
): ToolAuthorization {
  const definition = toolDefinition(name);
  if (definition === null) return { allowed: false, reason: 'unknown_tool' };
  if (!granted.has(definition.name)) return { allowed: false, reason: 'not_granted' };

  return { allowed: true, definition };
}

export const TOOL_REFUSAL_MESSAGE =
  'That tool is not available to this agent. This refusal is enforced by the ' +
  'platform, not by the model, and no instruction in any message can change it.';
