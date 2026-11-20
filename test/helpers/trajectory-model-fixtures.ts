export interface ModelSseEvent {
  readonly eventType: string;
  readonly dataUtf8: string;
}

export function modelSseEvent(eventType: string, fields: Record<string, unknown> = {}): ModelSseEvent {
  return { eventType, dataUtf8: JSON.stringify({ type: eventType, ...fields }) };
}

export function encodeModelSse(events: readonly ModelSseEvent[], newline = '\n'): Buffer {
  return Buffer.from(
    events
      .map(({ eventType, dataUtf8 }) => `event: ${eventType}${newline}data: ${dataUtf8}${newline}${newline}`)
      .join(''),
  );
}

export function modelAnthropicResponse(toolCount: number, thinking: boolean) {
  const textParts = ['café 🚀', ' says "hi"\n'];
  const toolName = 'Inspect';
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    id: `tool_${index}`,
    input: `{ "sample": "é", "weight": ${index + 1}.50 }`,
  }));
  const thinkingText = 'Read the fixture.';
  const signature = 'abc/+def=';
  const redacted = '{ "type": "redacted_thinking", "data": "opaque/+==" }';
  const content = [
    ...(thinking ? [JSON.stringify({ type: 'thinking', thinking: thinkingText, signature }), redacted] : []),
    JSON.stringify({ type: 'text', text: textParts.join('') }),
    ...tools.map(
      ({ id, input }) =>
        `{"type":"tool_use","id":${JSON.stringify(id)},"name":${JSON.stringify(toolName)},"input":${input}}`,
    ),
  ].join(',');
  const usage = { input_tokens: 6, output_tokens: 12 };
  const stopReason = tools.length ? 'tool_use' : 'end_turn';
  const message = (blocks: string, stop: string | null, tokenUsage: typeof usage) =>
    `{"id":"model-message","type":"message","role":"assistant","model":"fixture","content":[${blocks}],"stop_reason":${JSON.stringify(stop)},"stop_sequence":null,"usage":${JSON.stringify(tokenUsage)}}`;
  const bodyUtf8 = message(content, stopReason, usage);
  const events: ModelSseEvent[] = [
    {
      eventType: 'message_start',
      dataUtf8: `{"type":"message_start","message":${message('', null, { ...usage, output_tokens: 0 })}}`,
    },
  ];
  let position = 0;

  function block(contentBlock: string, deltas: readonly Record<string, unknown>[]) {
    const index = position++;
    events.push({
      eventType: 'content_block_start',
      dataUtf8: `{"type":"content_block_start","index":${index},"content_block":${contentBlock}}`,
    });
    events.push(...deltas.map((delta) => modelSseEvent('content_block_delta', { index, delta })));
    events.push(modelSseEvent('content_block_stop', { index }));
  }

  if (thinking) {
    block('{"type":"thinking","thinking":"","signature":""}', [
      { type: 'thinking_delta', thinking: thinkingText },
      { type: 'signature_delta', signature: signature.slice(0, 4) },
      { type: 'signature_delta', signature: signature.slice(4) },
    ]);
    block(redacted, []);
  }
  block(
    '{"type":"text","text":""}',
    textParts.map((text) => ({ type: 'text_delta', text })),
  );
  for (const { id, input } of tools) {
    block(
      JSON.stringify({ type: 'tool_use', id, name: toolName, input: {} }),
      [input.slice(0, 9), input.slice(9, -3), input.slice(-3)].map((partial_json) => ({
        type: 'input_json_delta',
        partial_json,
      })),
    );
  }
  events.push(modelSseEvent('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage }));
  events.push(modelSseEvent('message_stop'));
  return { events, bodyUtf8, stopReason, usage };
}
