/**
 * Shared CLI help formatting module.
 *
 * Provides a declarative CommandSpec interface and formatting utilities
 * so every subcommand produces consistent, aligned help output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandOption {
  /** The long flag name, without dashes (e.g., 'agent'). */
  readonly flag: string;
  /** Optional single-character short alias (e.g., 'a'). */
  readonly short?: string;
  /** Human-readable description. */
  readonly description: string;
  /** Placeholder for the value (e.g., '<name>'). Omit for boolean flags. */
  readonly placeholder?: string;
}

export interface CommandSpec {
  /** The full command name as invoked (e.g., 'ironcurtain daemon'). */
  readonly name: string;
  /** One-line summary of what the command does. */
  readonly description: string;
  /** Usage lines shown at the top. Each string is a separate line. */
  readonly usage: readonly string[];
  /** Named subcommands, displayed in a table after the usage block. */
  readonly subcommands?: readonly { readonly name: string; readonly description: string }[];
  /** Command-line options, displayed in a table after subcommands. */
  readonly options?: readonly CommandOption[];
  /** Example invocations shown at the bottom. */
  readonly examples?: readonly string[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Pads `text` with spaces on the right to reach at least `width` characters. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Formats a single option into its flag string (e.g., '-a, --agent <name>'). */
function formatOptionFlag(opt: CommandOption): string {
  const parts: string[] = [];
  if (opt.short) {
    parts.push(`-${opt.short},`);
  }
  let longFlag = `--${opt.flag}`;
  if (opt.placeholder) {
    longFlag += ` ${opt.placeholder}`;
  }
  if (opt.short) {
    parts.push(longFlag);
  } else {
    // Indent to align with flags that have a short alias.
    // "-X, " is 4 chars, so we add 4 spaces of leading indent.
    parts.push(`    ${longFlag}`);
  }
  return parts.join(' ');
}

/**
 * Renders a two-column table (label + description) with consistent alignment.
 * Each row is indented by 2 spaces.
 */
function formatTable(rows: readonly { label: string; description: string }[]): string {
  const maxLabel = rows.reduce((max, r) => Math.max(max, r.label.length), 0);
  const colWidth = maxLabel + 2; // 2 spaces between columns

  return rows.map((r) => `  ${pad(r.label, colWidth)}${r.description}`).join('\n');
}

/**
 * Formats a CommandSpec into a complete help string.
 *
 * Layout:
 *   <name> - <description>
 *
 *   Usage:
 *     <usage lines>
 *
 *   Subcommands:      (if any)
 *     <table>
 *
 *   Options:          (if any)
 *     <table>
 *
 *   Examples:         (if any)
 *     <lines>
 */
export function formatHelp(spec: CommandSpec): string {
  const sections: string[] = [];

  // Header
  sections.push(`${spec.name} - ${spec.description}`);

  // Usage
  sections.push('Usage:\n' + spec.usage.map((u) => `  ${u}`).join('\n'));

  // Subcommands
  if (spec.subcommands && spec.subcommands.length > 0) {
    const rows = spec.subcommands.map((s) => ({ label: s.name, description: s.description }));
    sections.push('Subcommands:\n' + formatTable(rows));
  }

  // Options
  if (spec.options && spec.options.length > 0) {
    const rows = spec.options.map((o) => ({
      label: formatOptionFlag(o),
      description: o.description,
    }));
    sections.push('Options:\n' + formatTable(rows));
  }

  // Examples
  if (spec.examples && spec.examples.length > 0) {
    sections.push('Examples:\n' + spec.examples.map((e) => `  ${e}`).join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Prints formatted help to stderr.
 */
export function printHelp(spec: CommandSpec): void {
  console.error(formatHelp(spec));
}

/**
 * Convenience: if `values.help` is truthy, prints help and returns true.
 * Callers can use: `if (checkHelp(values, spec)) return;`
 */
export function checkHelp(values: { help?: boolean }, spec: CommandSpec): boolean {
  if (!values.help) return false;
  printHelp(spec);
  return true;
}
