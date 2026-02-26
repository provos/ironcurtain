/**
 * Converts Markdown to Signal-compatible styled text.
 *
 * Signal's styled text mode supports a subset of inline Markdown:
 * **bold**, *italic*, `mono`, ~strike~ (single tilde).
 *
 * Block-level elements (headings, code blocks, blockquotes, lists)
 * are mapped to plain text with structural whitespace since Signal
 * has no native block formatting.
 *
 * Uses the `marked` lexer to produce an AST, then walks it to emit
 * Signal-compatible markup. This avoids regex-based conversion which
 * would be fragile with nested or overlapping markup.
 */

import { marked, type Token, type Tokens } from 'marked';

/**
 * Converts a Markdown string to Signal-compatible styled text.
 *
 * The returned string contains Signal's inline markup syntax
 * (**bold**, *italic*, `mono`, ~strike~) and is intended to be
 * sent with `text_mode: "styled"` via the signal-cli REST API.
 *
 * Limitations:
 * - No syntax highlighting in code blocks
 * - Headers are bold text, not visually distinct sizes
 * - Tables are rendered as monospace text
 * - Images are replaced with "[Image: alt]" placeholder
 * - Nested blockquotes lose depth distinction
 */
export function markdownToSignal(markdown: string): string {
  const tokens = marked.lexer(markdown);
  const output: string[] = [];

  function emit(text: string): void {
    output.push(text);
  }

  function walkTokens(tokens: Token[]): void {
    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          emit('**');
          walkInline(heading.tokens);
          emit('**\n\n');
          break;
        }

        case 'paragraph': {
          const paragraph = token as Tokens.Paragraph;
          walkInline(paragraph.tokens);
          emit('\n\n');
          break;
        }

        case 'code': {
          const code = token as Tokens.Code;
          emit('`');
          emit(code.text);
          emit('`');
          emit('\n\n');
          break;
        }

        case 'blockquote': {
          const blockquote = token as Tokens.Blockquote;
          emit('| ');
          walkTokens(blockquote.tokens);
          break;
        }

        case 'list': {
          const list = token as Tokens.List;
          let idx = list.start || 1;
          for (const item of list.items) {
            emit(list.ordered ? `${idx}. ` : '- ');
            walkTokens(item.tokens);
            idx++;
          }
          break;
        }

        case 'space':
          emit('\n');
          break;

        case 'hr':
          emit('---\n\n');
          break;

        default:
          if ('text' in token && typeof token.text === 'string') {
            emit(token.text);
          }
          break;
      }
    }
  }

  function walkInline(tokens: Token[] | undefined): void {
    if (!tokens) return;
    for (const token of tokens) {
      switch (token.type) {
        case 'strong': {
          const strong = token as Tokens.Strong;
          emit('**');
          walkInline(strong.tokens);
          emit('**');
          break;
        }

        case 'em': {
          const em = token as Tokens.Em;
          emit('*');
          walkInline(em.tokens);
          emit('*');
          break;
        }

        case 'codespan': {
          const codespan = token as Tokens.Codespan;
          emit('`');
          emit(codespan.text);
          emit('`');
          break;
        }

        case 'del': {
          // Markdown ~~ -> Signal single ~
          const del = token as Tokens.Del;
          emit('~');
          walkInline(del.tokens);
          emit('~');
          break;
        }

        case 'link': {
          const link = token as Tokens.Link;
          walkInline(link.tokens);
          emit(` (${link.href})`);
          break;
        }

        case 'image': {
          const image = token as Tokens.Image;
          emit(`[Image: ${image.text || 'no description'}]`);
          break;
        }

        case 'text': {
          const textToken = token as Tokens.Text;
          emit(textToken.text);
          break;
        }

        case 'br':
          emit('\n');
          break;

        default:
          if ('text' in token && typeof token.text === 'string') {
            emit(token.text);
          }
          break;
      }
    }
  }

  walkTokens(tokens);

  return output.join('').trimEnd();
}
