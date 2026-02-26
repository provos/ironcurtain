import { describe, it, expect } from 'vitest';
import { markdownToSignal } from '../../src/signal/markdown-to-signal.js';

describe('markdownToSignal', () => {
  // --- Inline styles ---

  it('passes through bold text unchanged', () => {
    const result = markdownToSignal('Hello **world**');
    expect(result).toBe('Hello **world**');
  });

  it('passes through italic text unchanged', () => {
    const result = markdownToSignal('Hello *world*');
    expect(result).toBe('Hello *world*');
  });

  it('passes through inline code unchanged', () => {
    const result = markdownToSignal('Run `npm install`');
    expect(result).toBe('Run `npm install`');
  });

  it('converts strikethrough from double tilde to single tilde', () => {
    const result = markdownToSignal('~~removed~~');
    expect(result).toBe('~removed~');
  });

  // --- Block elements ---

  it('converts headings to bold text', () => {
    const result = markdownToSignal('## Title\n\nBody text');
    expect(result).toContain('**Title**');
    expect(result).toContain('Body text');
  });

  it('converts h1 headings to bold text', () => {
    const result = markdownToSignal('# Main Title');
    expect(result).toContain('**Main Title**');
  });

  it('converts code blocks to backtick-wrapped text', () => {
    const result = markdownToSignal('```\ncode here\n```');
    expect(result).toContain('`code here`');
  });

  it('converts fenced code blocks with language to backtick-wrapped text', () => {
    const result = markdownToSignal('```json\n{"key": "value"}\n```');
    expect(result).toContain('`{"key": "value"}`');
  });

  it('converts blockquotes to pipe-prefixed text', () => {
    const result = markdownToSignal('> quoted text');
    expect(result).toContain('| ');
    expect(result).toContain('quoted text');
  });

  it('preserves unordered list items', () => {
    const result = markdownToSignal('- first\n- second\n- third');
    expect(result).toContain('- first');
    expect(result).toContain('- second');
    expect(result).toContain('- third');
  });

  it('preserves ordered list items', () => {
    const result = markdownToSignal('1. first\n2. second\n3. third');
    expect(result).toContain('1. first');
    expect(result).toContain('2. second');
    expect(result).toContain('3. third');
  });

  it('converts horizontal rules', () => {
    const result = markdownToSignal('above\n\n---\n\nbelow');
    expect(result).toContain('---');
  });

  // --- Links and images ---

  it('converts links to text with parenthesized URL', () => {
    const result = markdownToSignal('[click here](https://example.com)');
    expect(result).toContain('click here (https://example.com)');
  });

  it('replaces images with alt text placeholder', () => {
    const result = markdownToSignal('![screenshot](https://example.com/img.png)');
    expect(result).toBe('[Image: screenshot]');
  });

  it('uses fallback text for images without alt', () => {
    const result = markdownToSignal('![](https://example.com/img.png)');
    expect(result).toBe('[Image: no description]');
  });

  // --- Nested and combined styles ---

  it('handles nested bold and code', () => {
    const result = markdownToSignal('**bold and `code`**');
    expect(result).toContain('**bold and `code`**');
  });

  it('handles bold inside italic', () => {
    const result = markdownToSignal('*italic **bold** italic*');
    expect(result).toContain('*italic **bold** italic*');
  });

  // --- Edge cases ---

  it('returns empty string for empty input', () => {
    const result = markdownToSignal('');
    expect(result).toBe('');
  });

  it('trims trailing whitespace', () => {
    const result = markdownToSignal('Hello world\n\n');
    expect(result).toBe('Hello world');
  });

  it('handles plain text without markup', () => {
    const result = markdownToSignal('Just some plain text.');
    expect(result).toBe('Just some plain text.');
  });

  // --- Real-world example ---

  it('converts a typical agent response', () => {
    const markdown = [
      '## Tool Result',
      '',
      'The file `config.json` was **successfully** written.',
      '',
      '```json',
      '{"key": "value"}',
      '```',
    ].join('\n');

    const result = markdownToSignal(markdown);
    expect(result).toContain('**Tool Result**');
    expect(result).toContain('`config.json`');
    expect(result).toContain('**successfully**');
    expect(result).toContain('`{"key": "value"}`');
  });
});
