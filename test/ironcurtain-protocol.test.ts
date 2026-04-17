/**
 * Unit tests for the in-process IronCurtain UTCP communication protocol.
 *
 * Covers the post-review behavior that `callTool` preserves the MCP
 * response shape (does NOT throw on `isError: true`). The V8 isolate
 * expects a readable error payload, not an exception; throwing here
 * regresses every policy-denied call into an uncaught sandbox error.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { CommunicationProtocol, type CallTemplate, type IUtcpClient } from '@utcp/sdk';
import {
  IRONCURTAIN_CALL_TEMPLATE_TYPE,
  bindCoordinatorToManual,
  registerIronCurtainProtocol,
  unbindCoordinatorFromManual,
} from '../src/sandbox/ironcurtain-protocol.js';
import type { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import type { ToolCallResponse } from '../src/trusted-process/tool-call-pipeline.js';

beforeAll(() => {
  registerIronCurtainProtocol();
});

/** Coordinator stub that returns a predetermined response. */
function stubCoordinator(response: ToolCallResponse): ToolCallCoordinator {
  return {
    // Only the in-process UTCP protocol callsite is exercised here,
    // so we only stub the method it needs.
    handleToolCall: async () => response,
    getRegisteredTools: () => [],
  } as unknown as ToolCallCoordinator;
}

/** Fetches the registered IronCurtain communication protocol. */
function getProtocol(): CommunicationProtocol {
  const proto = CommunicationProtocol.communicationProtocols[IRONCURTAIN_CALL_TEMPLATE_TYPE];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime lookup may miss registration; defensive check
  if (!proto) throw new Error('IronCurtain protocol not registered');
  return proto;
}

describe('IronCurtainCommunicationProtocol.callTool', () => {
  it('returns the response shape as-is for successful calls', async () => {
    const expected: ToolCallResponse = {
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    };
    const coordinator = stubCoordinator(expected);
    const name = 'test-manual-success';
    bindCoordinatorToManual(name, coordinator);
    try {
      const result = await getProtocol().callTool({} as IUtcpClient, `${name}.server.tool`, {}, {
        name,
        call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE,
      } as CallTemplate);
      expect(result).toEqual(expected);
    } finally {
      unbindCoordinatorFromManual(name);
    }
  });

  it('returns the response shape as-is when isError:true (does NOT throw)', async () => {
    // Pre-refactor behavior (matching @utcp/mcp._processMcpToolResult)
    // returned the response regardless of `isError`. Throwing here
    // would regress every policy-denied / missing-annotation call in
    // the V8 isolate into an uncaught sandbox error.
    const errorResponse: ToolCallResponse = {
      content: [{ type: 'text', text: 'DENIED: protected path' }],
      isError: true,
    };
    const coordinator = stubCoordinator(errorResponse);
    const name = 'test-manual-error';
    bindCoordinatorToManual(name, coordinator);
    try {
      const result = await getProtocol().callTool(
        {} as IUtcpClient,
        `${name}.filesystem.read_file`,
        { path: '/etc/passwd' },
        { name, call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE } as CallTemplate,
      );
      // The important invariant: the call resolves, does not throw.
      expect(result).toEqual(errorResponse);
      expect((result as ToolCallResponse).isError).toBe(true);
    } finally {
      unbindCoordinatorFromManual(name);
    }
  });
});
