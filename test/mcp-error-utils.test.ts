import { describe, it, expect } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { extractMcpErrorMessage } from '../src/trusted-process/mcp-error-utils.js';

describe('extractMcpErrorMessage', () => {
  describe('schema validation errors (InvalidParams)', () => {
    it('extracts data when data is a string', () => {
      const err = new McpError(
        ErrorCode.InvalidParams,
        'Structured content does not match',
        'No session working directory set',
      );
      expect(extractMcpErrorMessage(err)).toBe('No session working directory set');
    });

    it('extracts data.message', () => {
      const err = new McpError(ErrorCode.InvalidParams, 'schema mismatch', { message: 'Repository not found' });
      expect(extractMcpErrorMessage(err)).toBe('Repository not found');
    });

    it('extracts data.error', () => {
      const err = new McpError(ErrorCode.InvalidParams, 'schema mismatch', { error: 'Permission denied' });
      expect(extractMcpErrorMessage(err)).toBe('Permission denied');
    });

    it('extracts text from data.content array', () => {
      const err = new McpError(ErrorCode.InvalidParams, 'schema mismatch', {
        content: [{ type: 'text', text: 'File not found: /tmp/missing' }],
      });
      expect(extractMcpErrorMessage(err)).toBe('File not found: /tmp/missing');
    });

    it('falls back to prefix-stripping when data has no extractable message', () => {
      const err = new McpError(ErrorCode.InvalidParams, 'Invalid params', { unrelated: 42 });
      expect(extractMcpErrorMessage(err)).toBe('Invalid params');
    });

    it('falls back to prefix-stripping when data is null', () => {
      const err = new McpError(ErrorCode.InvalidParams, 'something wrong');
      expect(extractMcpErrorMessage(err)).toBe('something wrong');
    });
  });

  describe('non-schema McpError (prefix stripping)', () => {
    it('strips MCP error prefix', () => {
      const err = new McpError(ErrorCode.InternalError, 'Server crashed');
      // McpError prepends "MCP error -32603: "
      expect(extractMcpErrorMessage(err)).toBe('Server crashed');
    });

    it('strips prefix for MethodNotFound', () => {
      const err = new McpError(ErrorCode.MethodNotFound, 'Tool not available');
      expect(extractMcpErrorMessage(err)).toBe('Tool not available');
    });
  });

  describe('non-McpError values', () => {
    it('returns message from regular Error', () => {
      expect(extractMcpErrorMessage(new Error('connection refused'))).toBe('connection refused');
    });

    it('converts non-Error to string', () => {
      expect(extractMcpErrorMessage('raw string error')).toBe('raw string error');
    });

    it('converts number to string', () => {
      expect(extractMcpErrorMessage(42)).toBe('42');
    });

    it('converts null to string', () => {
      expect(extractMcpErrorMessage(null)).toBe('null');
    });
  });
});
