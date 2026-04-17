---
name: UTCP custom in-process protocol
description: UTCP SDK supports registering custom CommunicationProtocol implementations for in-process tool dispatch (no subprocess needed)
type: project
---

# UTCP custom in-process protocol

## Fact

`@utcp/sdk` exposes `CommunicationProtocol` as a public abstract class with
four required methods (`registerManual`, `deregisterManual`, `callTool`,
`callToolStreaming`). Registration is a two-line mutation of static
registries:

```typescript
// Same pattern @utcp/mcp uses in its register() function:
CallTemplateSerializer.registerCallTemplate(
  '<type>', new <Type>CallTemplateSerializer(), override
);
CommunicationProtocol.communicationProtocols['<type>'] =
  new <Type>CommunicationProtocol();
```

This means any custom `call_template_type` can be handled by an in-process
class whose `callTool()` runs in the same Node process as the caller -- no
stdio, no subprocess.

## Why it matters

Relevant for the workflow-container-lifecycle design (v4). The v3 draft
assumed UTCP tool calls could only reach the policy coordinator via stdio
through a subprocess. The spike disproved this: IronCurtain can register its
own `'ironcurtain'` protocol whose `callTool` directly invokes
`coordinator.handleToolCall()`. This collapses the UTCP → coordinator path
to a single JS function call and removes the last architectural reason to
keep the N-subprocess topology on the UTCP side.

## How to apply

- When designing cross-module boundaries that currently ride on UTCP, check
  whether a custom `CommunicationProtocol` is cleaner than a call-template
  trick or an external stdio MCP server.
- For reference: `@utcp/mcp/dist/index.js` shows the canonical
  `register()` implementation at line 4411 (in the installed package).
- UTCP's post-registration aliasing / catalog / help logic in
  `src/sandbox/index.ts:444-500` is protocol-agnostic -- it sees tools
  after registration regardless of which protocol produced them.

## Spike evidence location

- `node_modules/@utcp/sdk/dist/index.d.ts` lines 860-929 define the
  abstract class.
- `node_modules/@utcp/mcp/dist/index.js` tail shows the register() pattern.
- Worked example: `@utcp/direct-call` is the dev-dep referenced in
  `@utcp/code-mode`'s package.json (not installed locally but same pattern).
