
export class AnkiError extends Error {
  constructor(message, { ambiguous = false } = {}) {
    super(message);
    this.ambiguous = ambiguous; // true when the call may have reached the server (timeout, dropped reply)
  }
}

let rpcId = 0;

export async function ankiCall(env, name, args = {}, opts = {}) {
  return (await ankiCallFull(env, name, args, opts)).payload;
}

// The same call, with the reply's image content too (get_card_images sends its pictures as MCP image content
// after the JSON text, never in structuredContent): {payload, images: [{data (base64), mimeType}]}.
export async function ankiCallFull(env, name, args = {}, { timeoutMs = 30_000 } = {}) {
  if (!env.ANKI_MCP_URL) throw new AnkiError('Anki is not connected (ANKI_MCP_URL is not set).');
  let res;
  try {
    res = await fetch(env.ANKI_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new AnkiError(timedOut ? 'The Anki server did not answer in time.' : 'The Anki server could not be reached.', { ambiguous: true });
  }
  if (res.status === 404) throw new AnkiError('The Anki server did not recognise the connector link (check ANKI_MCP_URL).');
  if (!res.ok) throw new AnkiError(`The Anki server answered ${res.status}.`, { ambiguous: res.status >= 500 });
  let body;
  try { body = await res.json(); } catch { throw new AnkiError('The Anki server sent a reply that was not JSON.', { ambiguous: true }); }
  if (body.error) throw new AnkiError(`Anki: ${body.error.message || 'request refused'}`);
  const result = body.result || {};
  let payload = result.structuredContent;
  if (!payload) {
    const text = (result.content || []).find(c => c.type === 'text');
    try { payload = text ? JSON.parse(text.text) : {}; } catch { payload = { text: text && text.text }; }
  }
  if (result.isError) throw new AnkiError(`Anki: ${(payload && payload.error) || 'the tool failed'}`);
  if (payload && payload.error && Object.keys(payload).length <= 3 && !payload.ok) throw new AnkiError(`Anki: ${payload.error}`);
  const images = (result.content || []).filter(c => c && c.type === 'image' && typeof c.data === 'string')
    .map(c => ({ data: c.data, mimeType: c.mimeType || 'image/jpeg' }));
  return { payload, images };
}

// Error types as the server stores them (study_log.ERROR_TYPES).
export const SERVER_ERROR = {
  'knowledge gap': 'knowledge_gap',
  misread: 'misread',
  'premature closure': 'premature_closure',
  'faulty synthesis': 'faulty_synthesis',
  'test-taking': 'test_taking',
  'threshold or number': 'threshold',
  calculation: 'calculation',
};
