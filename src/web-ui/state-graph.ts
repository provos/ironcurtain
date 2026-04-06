/**
 * Extracts a StateGraphDto from a WorkflowDefinition.
 *
 * Pure function -- no runtime state needed. Handles all state types
 * (agent, human_gate, deterministic, terminal) exhaustively.
 */

import type { WorkflowDefinition } from '../workflow/types.js';
import type { StateGraphDto, StateNodeDto, TransitionEdgeDto } from './web-ui-types.js';

/**
 * Converts a WorkflowDefinition into a minimal graph representation
 * suitable for frontend rendering (dagre layout + SVG).
 */
export function extractStateGraph(definition: WorkflowDefinition): StateGraphDto {
  const states: StateNodeDto[] = [];
  const transitions: TransitionEdgeDto[] = [];

  for (const [id, state] of Object.entries(definition.states)) {
    states.push({
      id,
      type: state.type,
      persona: state.type === 'agent' ? state.persona : undefined,
      label: formatStateLabel(id),
    });

    switch (state.type) {
      case 'agent':
      case 'deterministic':
        for (const t of state.transitions) {
          transitions.push({
            from: id,
            to: t.to,
            guard: t.guard,
            label: t.guard ? formatGuardLabel(t.guard) : '',
          });
        }
        break;

      case 'human_gate':
        for (const t of state.transitions) {
          transitions.push({
            from: id,
            to: t.to,
            event: t.event,
            label: formatEventLabel(t.event),
          });
        }
        break;

      case 'terminal':
        break;
    }
  }

  return { states, transitions };
}

// ---------------------------------------------------------------------------
// Label formatters
// ---------------------------------------------------------------------------

/** Converts snake_case state IDs to Title Case labels. */
function formatStateLabel(id: string): string {
  return id
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Formats a guard name into a readable label. */
function formatGuardLabel(guard: string): string {
  // Strip common prefixes and convert camelCase to spaced words
  const stripped = guard.replace(/^is/, '').replace(/^has/, 'Has ');
  return stripped
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
}

/** Formats an event type into a readable label. */
function formatEventLabel(event: string): string {
  return event
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
