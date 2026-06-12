// Zero-dependency OpenAI-compatible mock server for token-free testing.
//
// Usage:
//   node test/mock-server.mjs                 # normal mode, port 8787
//   MODE=mismatch node test/mock-server.mjs   # drop one %%N%% marker (exercise fallback)
//   MODE=429 node test/mock-server.mjs        # always rate-limited
//   MODE=500 node test/mock-server.mjs        # always server error
//   MODE=slow node test/mock-server.mjs       # 3s delay per request (spinner/concurrency)
//   MODE=badkey node test/mock-server.mjs     # 401 unless Authorization: Bearer test
//   PORT=9000 node test/mock-server.mjs
//
// Point the userscript at: API Base URL = http://localhost:8787/v1, API key = test

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const MODE = process.env.MODE || 'ok';

// CORS headers let the GM-less browser harness (test/harness.html) call us via
// fetch; the real userscript uses GM_xmlhttpRequest, which ignores CORS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
}

function chatResponse(content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// Translate by prefixing each segment with 【譯】 so output is visually distinct.
function fakeTranslate(text) {
  return '【譯】' + text;
}

function buildContent(userMessage) {
  const markers = [...userMessage.matchAll(/%%\s*(\d+)\s*%%\n([\s\S]*?)(?=\n%%\s*\d+\s*%%|$)/g)];
  if (markers.length === 0) {
    // Single-paragraph request: translate everything after the prompt header.
    const m = /Translate the text below to [^:]+:\s*\n+([\s\S]*)$/.exec(userMessage);
    return fakeTranslate((m ? m[1] : userMessage).trim());
  }
  let segments = markers.map(([, idx, text]) => ({ idx, text: text.trim() }));
  if (MODE === 'mismatch' && segments.length > 1) {
    segments = segments.slice(0, -1); // drop the last marker → parse mismatch
  }
  return segments.map((s) => `%%${s.idx}%%\n${fakeTranslate(s.text)}`).join('\n');
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    return reply(res, 404, { error: { message: `no route: ${req.method} ${req.url}` } });
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (MODE === '429') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2', ...CORS });
      return res.end(JSON.stringify({ error: { message: 'mock rate limit exceeded' } }));
    }
    if (MODE === '500') {
      return reply(res, 500, { error: { message: 'mock internal server error' } });
    }
    if (MODE === 'badkey' && req.headers.authorization !== 'Bearer test') {
      return reply(res, 401, { error: { message: 'mock invalid API key' } });
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(res, 400, { error: { message: 'invalid JSON body' } });
    }
    const userMsg = [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
    if (!userMsg) return reply(res, 400, { error: { message: 'no user message' } });

    if (MODE === 'slow') await new Promise((r) => setTimeout(r, 3000));
    const content = buildContent(userMsg.content);
    console.log(`[mock] ${payload.model} | ${userMsg.content.length} chars in | mode=${MODE}`);
    reply(res, 200, chatResponse(content));
  });
});

server.listen(PORT, () => {
  console.log(`[mock] OpenAI-compatible mock listening on http://localhost:${PORT}/v1 (mode=${MODE})`);
});
