import { describe, expect, it } from 'vitest';
import { anthropicRequestRewriter, type AgentKind } from '../../src/docker/provider-config.js';

const inspect = { name: 'Inspect', input_schema: { type: 'object' } };
const schedule = { name: 'CronCreate', type: 'custom', input_schema: { type: 'object' } };
const webSearch = { name: 'web_search', type: 'web_search_20250305' };
const nearbyName = { name: 'CronCreateReport', input_schema: { type: 'object' } };
const kinds = ['batch', 'workflow', 'pty', undefined] as const satisfies readonly (AgentKind | undefined)[];
const scenarios = ['all tools', 'history only', 'only schedule references', 'allowed only'] as const;
const cases = scenarios.flatMap((scenario) =>
  kinds.flatMap((agentKind) => [false, true].map((schemaFirst) => ({ scenario, agentKind, schemaFirst }))),
);

function toolReference(tool_name: string) {
  return { type: 'tool_reference', tool_name };
}

function functionBlock(name: string, schemaFirst: boolean): string {
  const parameters = {
    type: 'object',
    properties: { job: { type: 'object', default: { name: 'CronCreate' } } },
  };
  const schema = schemaFirst ? { parameters, name } : { name, parameters };
  return `<function>${JSON.stringify(schema)}</function>\n`;
}

function schemaText(...schemas: string[]) {
  return { type: 'text', text: `<functions>\n${schemas.join('')}</functions>` };
}

describe('MITM Anthropic tool filtering model', () => {
  it.each(cases)('$scenario kind=$agentKind schema-first=$schemaFirst', ({ scenario, agentKind, schemaFirst }) => {
    const oneShot = agentKind === 'batch' || agentKind === 'workflow';
    const allTools = scenario === 'all tools';
    const onlyReferences = scenario === 'only schedule references';
    const mentionsSchedule = scenario !== 'allowed only';
    const declared = allTools ? [inspect, webSearch, schedule, nearbyName] : [inspect, nearbyName];
    const expectedTools = allTools && !oneShot ? [inspect, schedule, nearbyName] : [inspect, nearbyName];

    const regularReference = toolReference(inspect.name);
    const scheduleReference = toolReference(schedule.name);
    const inspectSchema = functionBlock(inspect.name, schemaFirst);
    const scheduleSchema = functionBlock(schedule.name, schemaFirst);
    const references = onlyReferences
      ? [scheduleReference]
      : [
          regularReference,
          ...(mentionsSchedule ? [scheduleReference] : []),
          schemaText(...(mentionsSchedule ? [scheduleSchema] : []), inspectSchema),
        ];
    const expectedReferences =
      !oneShot || !mentionsSchedule
        ? references
        : onlyReferences
          ? [{ type: 'text', text: '(filtered)' }]
          : [regularReference, schemaText(inspectSchema)];
    const history = (content: object[]) => [
      { role: 'user', content: 'The report mentions CronCreate.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Search results' },
          { type: 'tool_result', tool_use_id: 'search-1', content },
        ],
      },
    ];
    const input = {
      model: 'fixture',
      max_tokens: 100,
      tools: declared,
      messages: history(references),
    };
    const snapshot = structuredClone(input);
    const expected = { ...input, tools: expectedTools, messages: history(expectedReferences) };
    const context = { method: 'POST', path: '/v1/messages', agentKind };
    const rewritten = anthropicRequestRewriter(input, context);

    expect(input).toEqual(snapshot);
    expect(rewritten?.modified ?? input).toEqual(expected);
    if (allTools || (oneShot && mentionsSchedule)) {
      expect(rewritten?.stripped).toEqual([
        ...(allTools ? [webSearch.type] : []),
        ...(allTools && oneShot ? [schedule.name] : []),
        ...(oneShot && mentionsSchedule && !onlyReferences
          ? [`tool_reference:${schedule.name}`, `function_block:${schedule.name}`]
          : []),
        ...(oneShot && onlyReferences ? [`tool_reference:${schedule.name}`] : []),
      ]);
    } else {
      expect(rewritten).toBeNull();
    }
    expect(anthropicRequestRewriter(rewritten?.modified ?? input, context)).toBeNull();
  });
});
