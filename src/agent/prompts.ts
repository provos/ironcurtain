/**
 * Builds the system prompt for the agent. Shared between
 * the legacy runAgent() function and the new AgentSession.
 */
export function buildSystemPrompt(
  toolCatalog: string,
  allowedDirectory?: string,
): string {
  const sandboxInfo = allowedDirectory
    ? `\nYour sandbox directory is: ${allowedDirectory}\nAll file operations within this directory are automatically allowed.\n`
    : '';

  return `You are a helpful assistant. You complete tasks by writing TypeScript code that executes in a secure sandbox.

Every tool call in your code goes through a security policy engine. If a call is denied, do NOT retry it -- explain the denial to the user.
${sandboxInfo}
## Code Mode rules

- Tools are synchronous — do NOT use \`await\`.
- Use \`return\` to send a value back to the conversation.
- Example: \`const result = filesystem.filesystem_list_directory({ path: "/tmp" });\`

## Available tools

${toolCatalog}

To get the full TypeScript interface for any tool (parameter types, optional params), call \`__getToolInterface('tool.name')\` inside your code.
`;
}
