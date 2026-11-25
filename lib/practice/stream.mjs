const invalid = () => { throw Error('model_provider_failed'); };

// An event may span transport chunks or contain multiple SSE data lines.
async function* frames(body) {
  let buffer = '', data = [], total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of body) {
    total += chunk.length;
    if (total > 1048576) invalid();
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 65536) invalid();
      if (!line) {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (!line.startsWith(':') && !line.startsWith('event:')) invalid();
    }
    if (Buffer.byteLength(buffer) > 65536) invalid();
  }
  decoder.decode();
}

export async function* translateStream(response) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) invalid();
  const calls = new Map();
  let finish, usage, done = false;
  for await (const frame of frames(response.body)) {
    if (frame === '[DONE]') { done = true; break; }
    const row = JSON.parse(frame);
    if (row?.error || !Array.isArray(row?.choices) || row.choices.length > 1) invalid();
    if (row.usage != null) {
      const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = row.usage;
      if (usage || ![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) invalid();
      usage = { type: 'usage', inputTokens, outputTokens };
      const cached = row.usage.prompt_tokens_details?.cached_tokens;
      if (Number.isSafeInteger(cached) && cached >= 0 && cached <= inputTokens) usage.cachedInputTokens = cached;
    }
    for (const choice of row.choices) {
      const delta = choice.delta ?? {};
      if ((choice.index ?? 0) !== 0 || delta.refusal || (finish && (delta.content || delta.tool_calls?.length))) invalid();
      if (delta.content != null && typeof delta.content !== 'string') invalid();
      if (delta.content) yield { type: 'text', text: delta.content };
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 32) invalid();
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        const tool = { type: 'tool', index: part.index, arguments: part.function?.arguments ?? '' };
        for (const [field, value] of [['id', part.id], ['name', part.function?.name]]) {
          if (value == null || value === call[field]) continue;
          if (typeof value !== 'string') invalid();
          tool[field] = value;
          call[field] += value;
        }
        if (typeof tool.arguments !== 'string') invalid();
        call.arguments += tool.arguments;
        if (call.id.length > 128 || call.name.length > 128 || call.arguments.length > 16384) invalid();
        calls.set(part.index, call);
        yield tool;
      }
      if (choice.finish_reason) {
        if (finish || !['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) invalid();
        finish = choice.finish_reason;
      }
    }
  }
  if (!done || !finish || !usage || (finish === 'stop' && calls.size)) invalid();
  if (finish === 'tool_calls') {
    const ids = new Set();
    if (!calls.size) invalid();
    for (const call of calls.values()) {
      const args = JSON.parse(call.arguments);
      if (!/^[\w.:-]{1,128}$/.test(call.id) || !/^[\w.:-]{1,128}$/.test(call.name) || ids.has(call.id) ||
          !args || typeof args !== 'object' || Array.isArray(args)) invalid();
      ids.add(call.id);
    }
  }
  yield usage;
  yield { type: 'finish', reason: finish };
}
