# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in IronCurtain, please report it responsibly. **Do not open a public issue.**

Email: **security@provos.org**

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The component affected (policy engine, sandbox, trusted process, MCP proxy, etc.)
- Whether you believe it affects the compiled policy, the runtime enforcement, or the sandbox boundary

I will acknowledge reports within 72 hours and aim to provide a fix or mitigation plan within 30 days.

## Scope

The following are in scope for security reports:

- **Policy engine bypasses** — crafted tool arguments that evade compiled rules
- **Sandbox escapes** — breaking out of the V8 isolate or the Anthropic SRT sandbox
- **Trusted process vulnerabilities** — exploiting the MCP proxy to bypass policy evaluation
- **Path traversal / symlink attacks** — circumventing directory containment checks
- **Credential leakage** — MCP server credentials exposed to the agent or in logs
- **Prompt injection leading to policy bypass** — adversarial input that causes the policy engine (not the LLM) to make incorrect decisions

The following are **out of scope**:

- The LLM itself being "jailbroken" — IronCurtain assumes the agent will be compromised and constrains consequences through architecture, not prevention (see [Why IronCurtain?](https://ironcurtain.dev/why))
- Vulnerabilities in upstream MCP servers that IronCurtain proxies to
- Denial of service against the local runtime (resource budgets are a convenience feature, not a security boundary)

## Security Architecture

IronCurtain's security model is defense-in-depth with multiple independent layers:

1. **V8 Sandbox** — agent code runs in an isolated V8 context with no access to `process`, `require`, or Node.js built-ins
2. **Trusted Process** — every MCP tool call passes through a policy engine before reaching any real server
3. **Policy Engine** — deterministic evaluation of compiled rules; structural invariants (protected paths, unknown tool denial) are hardcoded
4. **MCP Server Sandboxing** — each MCP server runs in its own Anthropic SRT sandbox with restricted filesystem and network access
5. **Human Escalation** — sensitive operations require explicit human approval

For a detailed threat analysis, see [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md).

## Supported Versions

IronCurtain is pre-1.0 research software. Security fixes will be applied to the latest release on `main`.
