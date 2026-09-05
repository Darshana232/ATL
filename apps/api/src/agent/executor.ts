/**
 * Tool execution: what actually happens when the agent calls a tool.
 *
 * THE CRITICAL PROPERTY OF THIS FILE: `request_authorization` and
 * `execute_payment` are HTTP CALLS TO THE TRUSTED ZONE, signed with the agent's
 * Ed25519 key. They are not function calls into the policy engine.
 *
 * That network hop is the trust boundary made real rather than diagrammatic.
 * The agent runtime cannot import `evaluate()`, cannot reach a payment
 * provider, and cannot mint a voucher. It can only ask - and asking goes
 * through code it does not control.
 *
 * If you are ever tempted to "optimise" this by calling the engine directly,
 * read ADR-0008 first. The latency saved is a few milliseconds; the property
 * lost is the entire product.
 */
import { randomBytes } from 'node:crypto';
import type { CatalogItem, CatalogProvider } from '../providers/catalog.js';
import {
  hashBody, signRequest, KEY_HEADER, TIMESTAMP_HEADER,
  IDEMPOTENCY_HEADER, SIGNATURE_HEADER,
} from '../auth/signing.js';

export interface AgentIdentity {
  readonly agentId: string;
  readonly keyId: string;
  /** The agent's own private key. The trusted zone never sees it. */
  readonly privateKeyPkcs8B64: string;
}

export interface ExecutionContext {
  readonly identity: AgentIdentity;
  readonly mandateId: string;
  /** Merchants the mandate permits, used to scope catalog search. */
  readonly allowedMerchantIds: readonly string[];
  /** Base URL of the ATL-India API. A real network hop. */
  readonly apiBaseUrl: string;
  readonly catalog: CatalogProvider;
  /** Injected so a demo and the tests can pin time. */
  readonly now: () => Date;
  /** Injected so tests can drive an in-process server without a socket. */
  readonly fetchImpl?: typeof fetch;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly content: unknown;
}

/** Signed HTTP call into the trusted zone. */
async function callApi(
  context: ExecutionContext,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  const timestamp = context.now().toISOString();
  const idempotencyKey = `agent_${randomBytes(10).toString('hex')}`;

  const signature = signRequest(context.identity.privateKeyPkcs8B64, {
    method: 'POST',
    path,
    timestamp,
    keyId: context.identity.keyId,
    idempotencyKey,
    bodySha256: hashBody(payload),
  });

  const doFetch = context.fetchImpl ?? fetch;

  const response = await doFetch(`${context.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [KEY_HEADER]: context.identity.keyId,
      [TIMESTAMP_HEADER]: timestamp,
      [IDEMPOTENCY_HEADER]: idempotencyKey,
      [SIGNATURE_HEADER]: signature,
    },
    body: payload,
  });

  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * Catalog text is UNTRUSTED INPUT.
 *
 * A product name or description is written by a merchant and read by a language
 * model, which makes it a prompt-injection surface. We do not try to sanitise
 * it - there is no reliable way to strip instructions from natural language,
 * and pretending otherwise creates false confidence.
 *
 * What we do instead:
 *   - bound it (the database CHECK already caps the length)
 *   - FENCE it, so the model is told plainly which text came from a merchant
 *   - and, above all, make it not matter: the agent's AUTHORITY is bounded,
 *     so an injected agent proposes something the engine refuses.
 *
 * The fence is a mitigation. The architecture is the defence.
 */
function fenceUntrusted(text: string): string {
  return `<merchant-supplied-text>${text}</merchant-supplied-text>`;
}

function summariseItem(item: CatalogItem): Record<string, unknown> {
  return {
    productId: item.productId,
    name: fenceUntrusted(item.name),
    description: fenceUntrusted(item.description),
    unitPricePaise: item.unitPricePaise,
    unit: item.unit,
    merchantId: item.merchantId,
    merchantName: item.merchantName,
    merchantMcc: item.merchantMcc,
  };
}

export interface CartLine {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly lineTotalPaise: number;
  readonly merchantId: string;
}

export interface Cart {
  readonly lines: readonly CartLine[];
  readonly totalPaise: number;
  readonly merchantId: string | null;
}

/**
 * Run one tool.
 *
 * The caller has ALREADY checked authorization (`authorizeToolCall`). This
 * function assumes the tool is permitted and does the work.
 */
export async function executeTool(
  context: ExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'search_products': {
      const items = await context.catalog.search({
        query: typeof input.query === 'string' ? input.query : undefined,
        // SCOPED TO THE MANDATE. The agent cannot even SEE products from
        // merchants it may not pay - the smallest useful attack surface.
        merchantIds: context.allowedMerchantIds,
        maxPricePaise:
          typeof input.maxPricePaise === 'number' ? input.maxPricePaise : undefined,
        limit: 20,
      });

      return { ok: true, content: { items: items.map(summariseItem) } };
    }

    case 'get_product': {
      const item = await context.catalog.get(String(input.productId ?? ''));

      if (item === null) return { ok: false, content: { error: 'No such product.' } };

      // Even a direct fetch is scoped: otherwise search restriction would be
      // trivially bypassed by guessing an id.
      if (!context.allowedMerchantIds.includes(item.merchantId)) {
        return {
          ok: false,
          content: { error: 'That product belongs to a merchant this mandate does not permit.' },
        };
      }

      return { ok: true, content: summariseItem(item) };
    }

    case 'create_cart': {
      const requested = Array.isArray(input.items) ? input.items : [];
      const lines: CartLine[] = [];

      for (const entry of requested) {
        const row = entry as { productId?: unknown; quantity?: unknown };
        const item = await context.catalog.get(String(row.productId ?? ''));

        if (item === null) {
          return { ok: false, content: { error: `Unknown product ${String(row.productId)}.` } };
        }
        if (!context.allowedMerchantIds.includes(item.merchantId)) {
          return {
            ok: false,
            content: { error: `Merchant ${item.merchantId} is not permitted by this mandate.` },
          };
        }

        const quantity = Math.max(1, Math.min(Number(row.quantity ?? 1) || 1, 100));

        lines.push({
          productId: item.productId,
          sku: item.sku,
          name: item.name,
          quantity,
          unitPricePaise: item.unitPricePaise,
          // INTEGER MULTIPLICATION. A cart total is a sum of integer paise;
          // there is no float anywhere in this path.
          lineTotalPaise: item.unitPricePaise * quantity,
          merchantId: item.merchantId,
        });
      }

      const merchants = new Set(lines.map((line) => line.merchantId));

      if (merchants.size > 1) {
        // One payment goes to one merchant. Splitting a cart across merchants
        // means several authorizations, which is a bigger feature than an MVP
        // needs - and silently paying only part of it would be worse.
        return {
          ok: false,
          content: { error: 'A cart must contain items from a single merchant.' },
        };
      }

      const cart: Cart = {
        lines,
        totalPaise: lines.reduce((sum, line) => sum + line.lineTotalPaise, 0),
        merchantId: lines[0]?.merchantId ?? null,
      };

      return { ok: true, content: cart };
    }

    case 'get_mandate': {
      // Read-only, and read through the API like everything else.
      const doFetch = context.fetchImpl ?? fetch;
      const response = await doFetch(
        `${context.apiBaseUrl}/v1/mandates/${context.mandateId}`,
        { method: 'GET' },
      );

      return { ok: response.ok, content: await response.json() };
    }

    case 'request_authorization': {
      // THE TRUST BOUNDARY. A signed HTTP call, not a function call.
      const { status, json } = await callApi(context, '/v1/authorize', {
        mandateId: context.mandateId,
        merchantId: String(input.merchantId ?? ''),
        amountPaise: Number(input.amountPaise ?? 0),
        paymentMethod: 'upi_reserve_pay',
      });

      return {
        ok: status === 200,
        content: {
          verdict: json.verdict,
          reason: json.reason,
          decisionId: json.decisionId,
          // The voucher is null on BLOCK. The agent has nothing to spend, and
          // no amount of persuasion changes that.
          voucher: (json.voucher as { token?: string } | null)?.token ?? null,
          evaluations: json.evaluations,
        },
      };
    }

    case 'execute_payment': {
      const { status, json } = await callApi(context, '/v1/payments', {
        voucher: String(input.voucher ?? ''),
        merchantId: String(input.merchantId ?? ''),
        amountPaise: Number(input.amountPaise ?? 0),
      });

      return {
        ok: status === 201 || status === 202,
        content: {
          httpStatus: status,
          paymentId: json.paymentId ?? null,
          status: json.status ?? json.error,
          message: json.message ?? json.failureReason ?? null,
          simulated: json.simulated ?? null,
        },
      };
    }

    case 'get_transaction': {
      const doFetch = context.fetchImpl ?? fetch;
      const path = `/v1/payments/${String(input.paymentId ?? '')}`;
      const timestamp = context.now().toISOString();
      const idempotencyKey = `agent_${randomBytes(10).toString('hex')}`;

      const signature = signRequest(context.identity.privateKeyPkcs8B64, {
        method: 'GET',
        // The signed path is the ROUTE PATTERN, matching what the server signs.
        path: '/v1/payments/:id',
        timestamp,
        keyId: context.identity.keyId,
        idempotencyKey,
        // A GET has no body, so the body hash is the hash of the empty string.
        bodySha256: hashBody(''),
      });

      const response = await doFetch(`${context.apiBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          [KEY_HEADER]: context.identity.keyId,
          [TIMESTAMP_HEADER]: timestamp,
          [IDEMPOTENCY_HEADER]: idempotencyKey,
          [SIGNATURE_HEADER]: signature,
        },
      });

      return { ok: response.ok, content: await response.json() };
    }

    default:
      // Unreachable: authorizeToolCall rejects unknown names before we get
      // here. Reaching it means the two got out of step, which is a bug worth
      // failing loudly for.
      return { ok: false, content: { error: `No executor for tool "${name}".` } };
  }
}
