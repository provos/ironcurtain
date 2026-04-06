/**
 * Markdown rendering helper for assistant output.
 * Converts markdown to sanitized HTML using marked + DOMPurify.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for inline rendering (no wrapping <p> tags for single lines)
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Renders markdown text to sanitized HTML.
 * Safe for use with {@html ...} in Svelte templates.
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
