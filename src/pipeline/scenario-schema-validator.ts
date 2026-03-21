/**
 * Validates test scenario arguments against tool input schemas.
 *
 * Catches common LLM errors: wrong argument names, missing required fields,
 * and invalid enum values. Uses the JSON Schema stored in tool annotations
 * (captured from MCP servers at annotation time).
 */

import type { StoredToolAnnotation, TestScenario, DiscardedScenario } from './types.js';

// ---------------------------------------------------------------------------
// JSON Schema helpers (minimal subset for validation)
// ---------------------------------------------------------------------------

interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function asJsonSchema(raw: Record<string, unknown>): JsonSchema {
  return raw as JsonSchema;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
  readonly message: string;
}

/**
 * Validates a scenario's arguments against the matching tool's inputSchema.
 *
 * Returns an empty array if the scenario is valid or if no matching
 * annotation/schema is found (graceful skip).
 */
export function validateScenarioArgs(
  scenario: TestScenario,
  storedAnnotations: StoredToolAnnotation[],
): SchemaValidationError[] {
  const annotation = storedAnnotations.find(
    (a) => a.serverName === scenario.request.serverName && a.toolName === scenario.request.toolName,
  );
  if (!annotation?.inputSchema) return [];

  const schema = asJsonSchema(annotation.inputSchema);
  if (!schema.properties) return [];

  const errors: SchemaValidationError[] = [];
  const scenarioArgs = scenario.request.arguments;
  const schemaPropertyNames = new Set(Object.keys(schema.properties));

  // Check for unknown argument names
  for (const argName of Object.keys(scenarioArgs)) {
    if (!schemaPropertyNames.has(argName)) {
      errors.push({ message: `unknown argument "${argName}" (valid: ${[...schemaPropertyNames].join(', ')})` });
    }
  }

  // Check for missing required fields
  if (schema.required) {
    for (const requiredArg of schema.required) {
      if (!(requiredArg in scenarioArgs)) {
        errors.push({ message: `missing required argument "${requiredArg}"` });
      }
    }
  }

  // Check enum constraints
  for (const [argName, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema.enum || !(argName in scenarioArgs)) continue;
    const value = scenarioArgs[argName];
    if (!propSchema.enum.includes(value)) {
      errors.push({
        message: `argument "${argName}" has invalid value ${JSON.stringify(value)} (valid: ${propSchema.enum.map((v) => JSON.stringify(v)).join(', ')})`,
      });
    }
  }

  return errors;
}

/**
 * Filters scenarios with invalid arguments, returning valid and discarded sets.
 *
 * Scenarios without a matching annotation or inputSchema are kept (not discarded).
 */
export function filterInvalidSchemaScenarios(
  scenarios: TestScenario[],
  storedAnnotations: StoredToolAnnotation[],
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const valid: TestScenario[] = [];
  const discarded: DiscardedScenario[] = [];

  for (const scenario of scenarios) {
    const errors = validateScenarioArgs(scenario, storedAnnotations);
    if (errors.length > 0) {
      discarded.push({
        scenario,
        actual: 'deny',
        rule: `invalid-schema: ${errors.map((e) => e.message).join('; ')}`,
      });
    } else {
      valid.push(scenario);
    }
  }

  return { valid, discarded };
}
