/**
 * The tool registry and its scope check.
 *
 * This is the ONE authorization function shared by the in-process runtime and
 * the MCP server. If it is wrong, both transports are wrong - which is exactly
 * why there is only one of it.
 */
import { describe, expect, it } from 'vitest';
import {
  authorizeToolCall, offeredTools, toolDefinition, TOOL_DEFINITIONS, TOOL_REFUSAL_MESSAGE,
} from './tools.js';

const SHOPPING = new Set([
  'search_products', 'get_product', 'create_cart',
  'get_mandate', 'request_authorization', 'execute_payment', 'get_transaction',
]);

describe('the registry', () => {
  it('defines the dangerous tools too', () => {
    // A tool-level authorization demo with nothing dangerous in the catalogue
    // proves nothing: there has to be something worth refusing.
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);

    expect(names).toContain('modify_mandate');
    expect(names).toContain('delete_audit_event');
    expect(names).toContain('export_all_users');
  });

  it('marks them sensitive', () => {
    for (const name of ['modify_mandate', 'delete_audit_event', 'export_all_users'] as const) {
      expect(toolDefinition(name)?.sensitive, name).toBe(true);
    }
  });

  it('gives every tool a JSON Schema, so one definition serves both transports', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
    }
  });

  it('has unique names', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('offering is hygiene', () => {
  it('offers only granted tools', () => {
    const offered = offeredTools(SHOPPING).map((tool) => tool.name);

    expect(offered.sort()).toEqual([...SHOPPING].sort());
  });

  it('offers nothing to an agent with no grants', () => {
    expect(offeredTools(new Set())).toHaveLength(0);
  });
});

describe('authorizing is the SECURITY CONTROL', () => {
  it('permits a granted tool', () => {
    const result = authorizeToolCall(SHOPPING, 'search_products');

    expect(result.allowed).toBe(true);
  });

  it('REFUSES an ungranted tool even though it exists', () => {
    // Hiding a capability is not removing it. A model can invent a tool name it
    // was never shown - and an attacker who has injected the context will tell
    // it to.
    for (const name of ['modify_mandate', 'delete_audit_event', 'export_all_users']) {
      const result = authorizeToolCall(SHOPPING, name);

      expect(result.allowed, name).toBe(false);
      if (!result.allowed) expect(result.reason).toBe('not_granted');
    }
  });

  it('refuses a tool that does not exist at all', () => {
    const result = authorizeToolCall(SHOPPING, 'drop_all_tables');

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('unknown_tool');
  });

  it('is not fooled by case, whitespace or near-misses', () => {
    for (const name of [
      'MODIFY_MANDATE', ' search_products', 'search_products ',
      'search_product', 'search_productss', '',
    ]) {
      expect(authorizeToolCall(SHOPPING, name).allowed, JSON.stringify(name)).toBe(false);
    }
  });

  it('refuses everything when the grant set is empty', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(authorizeToolCall(new Set(), tool.name).allowed, tool.name).toBe(false);
    }
  });

  it('tells the model the refusal is not negotiable', () => {
    // The message exists so a model does not waste turns arguing with it, and
    // so a human reading a transcript sees who refused.
    expect(TOOL_REFUSAL_MESSAGE).toContain('platform, not by the model');
  });
});
