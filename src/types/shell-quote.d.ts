declare module 'shell-quote' {
  /**
   * Joins an array of arguments into a shell-escaped string.
   * Each element is escaped so it can safely be used in a shell command.
   */
  export function quote(args: readonly string[]): string;

  /**
   * Parses a shell command string into an array of arguments.
   */
  export function parse(cmd: string): Array<string | { op: string }>;
}
