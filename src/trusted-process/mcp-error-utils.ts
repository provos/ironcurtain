import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ErrorCode is a numeric enum; widen to a plain number so the comparison against
// McpError.code (typed `number`) doesn't trip no-unsafe-enum-comparison.
const INVALID_PARAMS_CODE: number = ErrorCode.InvalidParams;

/**
 * Extracts a meaningful error message from an MCP server error.
 *
 * Schema validation errors (code -32602) often wrap the real server error
 * inside `err.data`. This function digs into the data to surface
 * the original message instead of the opaque schema mismatch text.
 *
 * For other McpError instances, strips the "MCP error -NNNNN: " prefix.
 * Falls back to err.message or String(err) for non-MCP errors.
 */
export function extractMcpErrorMessage(err: unknown): string {
  if (!(err instanceof McpError)) {
    return err instanceof Error ? err.message : String(err);
  }

  // Schema validation errors wrap the real error in `data`
  if (err.code === INVALID_PARAMS_CODE && err.data != null) {
    const extracted = extractFromData(err.data);
    if (extracted) return extracted;
  }

  // Strip the "MCP error -NNNNN: " prefix from the message
  return stripMcpPrefix(err.message);
}

function extractFromData(data: unknown): string | undefined {
  if (typeof data === 'string' && data.length > 0) return data;

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;

    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
    if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;

    // MCP content array: [{ type: "text", text: "..." }]
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        const entry = item as Record<string, unknown>;
        if (entry.type === 'text' && typeof entry.text === 'string') {
          return entry.text;
        }
      }
    }
  }
  return undefined;
}

function stripMcpPrefix(message: string): string {
  const match = message.match(/^MCP error -\d+: (.+)$/s);
  return match ? match[1] : message;
}
