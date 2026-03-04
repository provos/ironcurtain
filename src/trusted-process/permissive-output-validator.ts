/**
 * A permissive JSON Schema validator that always returns valid.
 *
 * MCP SDK v1.12.0+ validates tool structuredContent against the tool's declared
 * outputSchema on both server-side and client-side. The server-side validation
 * skips when isError=true (fixed in v1.13.2), but the client-side validation
 * in Client.callTool() still fires on structuredContent even when isError=true.
 *
 * This causes MCP servers that declare outputSchema but return non-conforming
 * structuredContent on errors (e.g. @cyanheads/git-mcp-server) to produce opaque
 * "Structured content does not match the tool's output schema" errors that hide
 * the real error message from the agent.
 *
 * IronCurtain acts as a proxy -- it does not consume structuredContent itself,
 * so it intentionally bypasses this client-side schema validation and simply
 * forwards whatever the MCP server returns, even if the server skipped its
 * own structuredContent validation for error responses.
 *
 * See: https://github.com/modelcontextprotocol/typescript-sdk/pull/1428
 * TODO: Remove once the SDK ships the isError skip fix for client-side validation.
 */
import type { jsonSchemaValidator, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';

export const permissiveJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      valid: true as const,
      data: input as T,
      errorMessage: undefined,
    });
  },
};
