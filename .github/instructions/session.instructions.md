---
applyTo: "src/session/**"
---

# Session Review Rules

The session layer manages the agent conversation lifecycle, including the AI SDK integration and escalation IPC.

## Mandatory Checks

- `generateText()` must use `stopWhen: [stepCountIs(n)]`, NOT `maxSteps`. The `maxSteps` API does not exist in AI SDK v6.
- `tool()` must use `inputSchema`, NOT `parameters`. The `parameters` API does not exist in AI SDK v6.
- Tool call results use `toolCalls[].input`, NOT `toolCalls[].args`.
- The tool type is `ToolSet`, NOT `CoreTool`.
- `SessionStatus` follows a linear state machine: `initializing -> ready -> processing -> ready -> closed`. The `processing` state prevents reentrant `sendMessage()` calls. Do not remove or bypass this guard.
- Escalation resolution writes a JSON file to the escalation directory. The file naming convention (`response-{escalationId}.json`) must match what the proxy expects. Changing the naming breaks the IPC contract.
- `writeUserContext()` writes the user's message for the auto-approver and must use `try/catch` with silent failure. The escalation directory may not exist yet.
- On `sendMessage()` failure, the message history must be truncated back to `messageCountBefore` to avoid leaving partial state. Removing this truncation corrupts the conversation history.
- User-facing output MUST use `process.stdout.write()` or `process.stderr.write()`, NOT `console.log()`. The logger module intercepts console methods and redirects to the session log file.
- The `SandboxFactory` type exists for test injection. The default factory creates a real sandbox; tests provide a mock. Do not remove this abstraction.
