/**
 * Builds the system prompt for the agent. Shared between
 * the legacy runAgent() function and the new AgentSession.
 */
export function buildSystemPrompt(
  codeModePrompt: string,
  toolInterfaces: string,
): string {
  return `You are a helpful assistant. You complete tasks by writing TypeScript code that executes in a secure sandbox.

Every tool call in your code goes through a security policy engine. Calls may be ALLOWED, DENIED, or require ESCALATION (human approval). If a call is denied, do NOT retry it \u2014 explain the denial to the user.

${codeModePrompt}

## Currently available tool interfaces

${toolInterfaces}
`;
}
