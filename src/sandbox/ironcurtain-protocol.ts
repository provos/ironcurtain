/**
 * In-process UTCP communication protocol that routes tool calls to a
 * `ToolCallCoordinator`.
 *
 * Registers a `call_template_type: 'ironcurtain'` with the UTCP SDK so
 * that a single registered manual can expose every tool the coordinator
 * knows about, with the policy gate running in the same Node process as
 * the caller (no stdio, no subprocess hop).
 *
 * The protocol is idempotent: `registerIronCurtainProtocol()` can be
 * called multiple times safely (subsequent calls are no-ops).
 */

import {
  CallTemplateSerializer,
  CommunicationProtocol,
  Serializer,
  UtcpManualSchema,
  type CallTemplate,
  type IUtcpClient,
  type RegisterManualResult,
} from '@utcp/sdk';
import type { ToolCallCoordinator } from '../trusted-process/tool-call-coordinator.js';

/**
 * The `call_template_type` identifier used for coordinator-backed manuals.
 * One-time registered with the UTCP SDK via `registerIronCurtainProtocol`.
 */
export const IRONCURTAIN_CALL_TEMPLATE_TYPE = 'ironcurtain';

/**
 * Shape of an IronCurtain UTCP call template. The `coordinator`
 * reference is carried on the template config so the protocol can reach
 * it from inside `callTool`.
 */
export interface IronCurtainCallTemplate extends CallTemplate {
  call_template_type: typeof IRONCURTAIN_CALL_TEMPLATE_TYPE;
  config: {
    /**
     * Coordinator reference. Never serialized (class instances are not
     * JSON-friendly); the serializer stores it by identity via a
     * module-level map keyed on the template `name`.
     */
    coordinator?: ToolCallCoordinator;
  };
}

/**
 * Serializers in UTCP produce and consume `Record<string, unknown>`
 * shapes (intended for JSON persistence). A class instance like
 * `ToolCallCoordinator` cannot survive `JSON.stringify`, so we keep the
 * live reference in a module-level map keyed by the manual name and
 * store only the name in the serialized dict.
 */
const coordinatorByManual = new Map<string, ToolCallCoordinator>();

class IronCurtainCallTemplateSerializer extends Serializer<IronCurtainCallTemplate> {
  toDict(obj: IronCurtainCallTemplate): Record<string, unknown> {
    return {
      name: obj.name,
      call_template_type: obj.call_template_type,
      allowed_communication_protocols: obj.allowed_communication_protocols,
      // Config serialization only preserves the manual name; the live
      // coordinator is resolved via the module-level map.
      config: { manual: obj.name },
    };
  }

  validateDict(obj: Record<string, unknown>): IronCurtainCallTemplate {
    const name = obj.name as string | undefined;
    if (!name) {
      throw new Error('IronCurtain call template requires a name.');
    }
    const coordinator = coordinatorByManual.get(name);
    return {
      name,
      call_template_type: IRONCURTAIN_CALL_TEMPLATE_TYPE,
      allowed_communication_protocols: obj.allowed_communication_protocols as string[] | undefined,
      config: { coordinator },
    };
  }
}

/**
 * UTCP `CommunicationProtocol` implementation that:
 *   - On `registerManual`: asks the coordinator for its tool catalog and
 *     returns it as a UTCP manual.
 *   - On `callTool`: strips the UTCP manual/server prefixes to recover the
 *     backend tool name, then delegates to
 *     `coordinator.handleToolCall(toolName, args)`.
 */
class IronCurtainCommunicationProtocol extends CommunicationProtocol {
  // eslint-disable-next-line @typescript-eslint/require-await -- UTCP interface mandates Promise return
  async registerManual(_caller: IUtcpClient, manualCallTemplate: CallTemplate): Promise<RegisterManualResult> {
    const coordinator = resolveCoordinator(manualCallTemplate);
    const registeredTools = coordinator.getRegisteredTools();

    // UTCP tool names are namespaced: "<manual>.<server>.<tool>".
    // This matches the pattern the MCP protocol already produces so the
    // sandbox's post-registration alias/help logic continues to work.
    const manualName = manualCallTemplate.name ?? 'tools';
    const utcpTools = registeredTools.map((t) => ({
      name: `${manualName}.${t.serverName}.${t.name}`,
      description: t.description ?? '',
      inputs: t.inputSchema,
      outputs: undefined,
      tags: [],
      tool_call_template: manualCallTemplate,
    }));

    return {
      manualCallTemplate,
      manual: UtcpManualSchema.parse({ tools: utcpTools }),
      success: true,
      errors: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- UTCP interface mandates Promise return
  async deregisterManual(_caller: IUtcpClient, manualCallTemplate: CallTemplate): Promise<void> {
    if (manualCallTemplate.name) {
      coordinatorByManual.delete(manualCallTemplate.name);
    }
  }

  async callTool(
    _caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallTemplate: CallTemplate,
  ): Promise<unknown> {
    const coordinator = resolveCoordinator(toolCallTemplate);

    // UTCP tool names arrive as "<manual>.<server>.<tool>". Parse both
    // the server name (for policy routing) and the bare tool name.
    const manualName = toolCallTemplate.name ?? 'tools';
    const prefix = `${manualName}.`;
    const stripped = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
    const dotIdx = stripped.indexOf('.');
    if (dotIdx < 0) {
      return {
        content: [{ type: 'text', text: `Malformed tool name (missing server segment): ${toolName}` }],
        isError: true,
      };
    }
    const serverName = stripped.slice(0, dotIdx);
    const backendToolName = stripped.slice(dotIdx + 1);

    const response = await coordinator.handleToolCall(serverName, backendToolName, toolArgs);
    return response;
  }

  async *callToolStreaming(
    caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallTemplate: CallTemplate,
  ): AsyncGenerator<unknown, void, unknown> {
    // IronCurtain tool calls are not natively streaming. Delegate to
    // the non-streaming form and yield the single result.
    const result = await this.callTool(caller, toolName, toolArgs, toolCallTemplate);
    yield result;
  }

  close(): Promise<void> {
    // Deliberately do NOT clear `coordinatorByManual` here: other
    // concurrent UTCP clients in the same process may still hold
    // references. The sandbox calls `unbindCoordinatorFromManual`
    // on shutdown to remove its own entry.
    return Promise.resolve();
  }
}

/**
 * Resolves the coordinator from a call-template. UTCP's variable
 * substitutor deep-clones the template's `config` into a plain object
 * on registration, so class instances cannot survive -- we always
 * resolve through `coordinatorByManual` keyed by the manual name.
 *
 * Callers must `bindCoordinatorToManual(name, coordinator)` before
 * invoking `UtcpClient.registerManual({ name, call_template_type: 'ironcurtain' })`.
 */
function resolveCoordinator(template: CallTemplate): ToolCallCoordinator {
  if (!template.name) {
    throw new Error('IronCurtain call-template has no name; cannot resolve coordinator.');
  }
  const viaMap = coordinatorByManual.get(template.name);
  if (!viaMap) {
    throw new Error(
      `IronCurtain call-template "${template.name}" has no coordinator binding. ` +
        'Call bindCoordinatorToManual(name, coordinator) before registerManual.',
    );
  }
  return viaMap;
}

let registered = false;

/**
 * Registers the `'ironcurtain'` call-template type and its communication
 * protocol with the UTCP SDK. Idempotent: subsequent calls are no-ops.
 *
 * Also executed at module load (see bottom of file) so importing this
 * module is sufficient to wire the protocol. Explicit invocation is
 * supported for callers that want to guarantee registration order.
 */
export function registerIronCurtainProtocol(): void {
  if (registered) return;
  CallTemplateSerializer.registerCallTemplate(
    IRONCURTAIN_CALL_TEMPLATE_TYPE,
    new IronCurtainCallTemplateSerializer(),
    /* override */ true,
  );
  CommunicationProtocol.communicationProtocols[IRONCURTAIN_CALL_TEMPLATE_TYPE] = new IronCurtainCommunicationProtocol();
  registered = true;
}

// Mirror @utcp/mcp: perform registration as a side-effect of import so
// `UtcpClient.registerManual({call_template_type: 'ironcurtain', ...})`
// finds the protocol even before any explicit `registerIronCurtainProtocol()`
// call.
registerIronCurtainProtocol();

/**
 * Associates a coordinator with a manual name so the protocol can look
 * it up during `callTool`. Must be called before `registerManual`
 * for the given name.
 */
export function bindCoordinatorToManual(manualName: string, coordinator: ToolCallCoordinator): void {
  coordinatorByManual.set(manualName, coordinator);
}

/** Removes the coordinator binding. Called by the Sandbox on shutdown. */
export function unbindCoordinatorFromManual(manualName: string): void {
  coordinatorByManual.delete(manualName);
}
