/**
 * Mandatory handwritten test scenarios for the policy compilation pipeline.
 *
 * These are fed to the LLM compiler as ground-truth constraints that the
 * compiled rules MUST satisfy, and are verified after every compilation.
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  ONLY universal, constitution-independent invariants belong here. ║
 * ║                                                                   ║
 * ║  These scenarios constrain what the LLM compiler can produce.     ║
 * ║  Adding server-specific or constitution-dependent scenarios       ║
 * ║  (e.g., "git push must escalate", "Gmail send must escalate")     ║
 * ║  will CONFLICT with user constitutions that make different        ║
 * ║  choices for those servers.                                       ║
 * ║                                                                   ║
 * ║  Server-specific policy tests belong in policy-engine.test.ts,    ║
 * ║  where they validate the current compiled policy without          ║
 * ║  constraining what the compiler can generate.                     ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Current invariants:
 *   1. Filesystem sandbox containment — writes/deletes outside the
 *      sandbox must never be allowed regardless of constitution.
 */

import type { TestScenario } from './types.js';

export function getHandwrittenScenarios(sandboxDir: string): TestScenario[] {
  return [
    // Move from outside sandbox carries delete-path on source — must not be allowed
    {
      description: 'Move file from outside sandbox to sandbox -- not allowed',
      request: {
        serverName: 'filesystem',
        toolName: 'move_file',
        arguments: { source: '/etc/important.txt', destination: `${sandboxDir}/important.txt` },
      },
      expectedDecision: 'not-allow',
      reasoning:
        'Move carries delete-path on the source outside the sandbox; the agent must not be able to do this without human intervention.',
      source: 'handwritten',
    },

    // Universal "human oversight for writes outside sandbox" invariant
    {
      description: 'Write file outside sandbox -- not allowed',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/etc/test.txt', content: 'hello' },
      },
      expectedDecision: 'not-allow',
      reasoning: 'Writes outside permitted areas must not be allowed without human intervention.',
      source: 'handwritten',
    },
  ];
}
