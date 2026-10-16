'use strict';
// GBot server. No npm packages needed. Serves the page and relays chat messages
// to Google Gemini. Your API key stays here on the server and never reaches the browser.
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 3000;
const KEY = process.env.GEMINI_API_KEY || '';
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const MODELS = {
  quick: process.env.MODEL_QUICK || 'gemini-flash-lite-latest',
  default: process.env.MODEL_DEFAULT || 'gemini-flash-latest'
};
MODELS.complex = process.env.MODEL_DEEP || MODELS.default;
const PER_MIN = Number(process.env.RATE_PER_MIN) || 20;      // messages per visitor per minute
const PER_DAY = Number(process.env.RATE_PER_DAY) || 200;     // messages per visitor per day
const GLOBAL_DAY = Number(process.env.GLOBAL_PER_DAY) || 700; // messages for everyone per day
const MAX_BODY = 4 * 1024 * 1024;
// Small safety patches applied to the page when the server starts. They only act on the
// older page text, so they do nothing once index.html already contains the fixes.
function patchHtml(src) {
  const P = [
    ["list=document.createElement(ord?'ol':'ul');el.appendChild(list)", "list=document.createElement(ord?'ol':'ul');if(ord){const n=parseInt(m[1],10);if(n>1)list.start=n}el.appendChild(list)"],
    ["let tier='default';", "let tier='quick';"],
    ["localStorage.getItem('gbot:tier')||'default'", "localStorage.getItem('gbot:tier')||'quick'"],
    ["if(!TIERS.some(t=>t[0]===tier))tier='default';", "if(!TIERS.some(t=>t[0]===tier))tier='quick';"],
    ["c==='busy'?'GBot is very busy right now. Please try again later.'", "c==='deep_busy'?'Deep thinking has reached its free limit for now. Please try Fast replies or Balanced.':c==='busy'?'GBot is very busy right now. Please try again later.'"]
  ];
  let n = 0;
  for (const [a, b] of P) { if (src.includes(a)) { src = src.split(a).join(b); n++; } }
  console.log('Page patches applied: ' + n);
  return src;
}
const HTML = Buffer.from(patchHtml(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')), 'utf8');
// Last result per speed level, shown on /healthz so problems are easy to diagnose (no secrets).
const stats = {};
const note = (k, model, status, ms) => { stats[k] = { model, status, ms, at: new Date().toISOString() }; };

const SYSTEM = "You are GBot 1.0, a cheerful, upbeat and knowledgeable general-purpose AI helper. You are friendly and encouraging, with light, warm humor when it fits, but always clear and accurate. If asked your name, say you are GBot. You were built and are owned by Goody, and you are free to use. If anyone asks who made, built, owns or created you, answer warmly and briefly, for example: I'm GBot, built by Goody. If anyone asks who Goody is, say: Goody built and owns GBot, and I don't have other personal details about them. Never invent facts about Goody. If asked which AI model or technology powers you, be honest that you run on Google's Gemini. Never claim that Google, OpenAI or Anthropic built GBot itself. Use markdown (short paragraphs, lists, bold, code blocks, tables when helpful). Keep answers concise unless asked for detail.";
const MODES = {
  friendly: '',
  study: ' Act as a patient tutor: explain step by step, check understanding, and offer short practice questions.',
  coder: ' Act as an expert programmer: give correct, commented code in code blocks and explain briefly.',
  concise: ' Be extremely concise: short direct answers, no fluff.',
  creative: ' Act as an imaginative writing partner: vivid, original and playful.',
  writing: ' Act as a supportive writing coach: improve clarity and style and briefly explain your edits.',
  business: ' Act as a practical business and side-hustle advisor: give realistic, step-by-step, low-budget ideas.',
  language: ' Act as a friendly language tutor: help the user practise, gently correct mistakes and explain briefly.'
};
const LANGS = ['English', 'Nigerian Pidgin', 'Yoruba', 'Igbo', 'Hausa', 'French', 'Spanish', 'Portuguese', 'Arabic'];
const TITLE_SYSTEM = 'You write short conversation titles. Reply with only the title: maximum 5 words, no quotes, no ending punctuation.';
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const hdr = (o) => Object.assign({}, SEC, o);
const send = (res, code, obj) => { res.writeHead(code, hdr({ 'content-type': 'application/json', 'cache-control': 'no-store' })); res.end(JSON.stringify(obj)); };

// ---- simple rate limiting (kept in memory) ----
const hits = new Map(); let day = new Date().toDateString(), gday = 0;
function limited(ip) {
  const now = Date.now(), d = new Date().toDateString();
  if (d !== day) { day = d; hits.clear(); gday = 0; }
  if (hits.size > 50000) hits.clear();
  if (gday >= GLOBAL_DAY) return 'busy';
  let h = hits.get(ip); if (!h) { h = { t: [], n: 0 }; hits.set(ip, h); }
  h.t = h.t.filter(x => now - x < 60000);
  if (h.t.length >= PER_MIN || h.n >= PER_DAY) return 'rate_limited';
  h.t.push(now); h.n++; gday++; return null;
}
const clientIp = (req) => {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim(); if (cf) return cf;       // set by the host's edge network
  const tc = String(req.headers['true-client-ip'] || '').trim(); if (tc) return tc;
  const f = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return f.length ? f[0] : (req.socket.remoteAddress || 'unknown');
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, big = false;
    req.on('data', d => { n += d.length; if (n > MAX_BODY) big = true; else chunks.push(d); });
    req.on('end', () => big ? reject(new Error('big')) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const clip = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);

function buildSystem(mode, p) {
  p = p && typeof p === 'object' ? p : {};
  let x = SYSTEM + (MODES[mode] || '');
  const nick = clip(p.nick, 40), about = clip(p.about, 500), how = clip(p.how, 500);
  if (nick) x += " The user's name is " + nick + '; use it naturally.';
  if (p.length === 'short') x += ' Keep replies short (a few sentences) unless asked for more.';
  if (p.length === 'detailed') x += ' Give thorough, detailed answers.';
  if (LANGS.includes(p.lang)) x += ' Always reply in ' + p.lang + '.';
  if (about) x += ' About the user: ' + about;
  if (how) x += ' How the user prefers to be answered: ' + how;
  return x;
}

async function chat(req, res) {
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' }); } catch (e) { return send(res, 403, { error: 'forbidden' }); } }
  if (!KEY) return send(res, 500, { error: 'not_configured' });
  if (String(req.headers['content-type'] || '').indexOf('application/json') !== 0) return send(res, 415, { error: 'bad_request' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return send(res, 413, { error: 'too_large' });
  const lim = limited(clientIp(req)); if (lim) return send(res, 429, { error: lim });
  let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.message === 'big' ? 413 : 400, { error: e.message === 'big' ? 'too_large' : 'bad_request' }); }
  const msgs = b && b.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 40) return send(res, 400, { error: 'bad_request' });
  const contents = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > 40000) return send(res, 400, { error: 'bad_request' });
    contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] });
  }
  if (contents[0].role !== 'user' || contents[contents.length - 1].role !== 'user') return send(res, 400, { error: 'bad_request' });
  const imgs = Array.isArray(b.images) ? b.images : [];
  if (imgs.length > 2) return send(res, 400, { error: 'bad_request' });
  for (const im of imgs) {
    if (!im || !IMG_TYPES.includes(im.mime) || typeof im.data !== 'string' || im.data.length > 2500000 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return send(res, 400, { error: 'bad_request' });
    contents[contents.length - 1].parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  }
  const title = b.task === 'title';
  const model = title ? MODELS.quick : (MODELS[b.tier] || MODELS.default);
  const tkey = title ? 'title' : (MODELS[b.tier] ? b.tier : 'default'), t0 = Date.now();
  const body = { systemInstruction: { parts: [{ text: title ? TITLE_SYSTEM : buildSystem(b.mode, b.prefs) }] }, contents };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 90000);
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const up = await fetch(BASE + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ac.signal
    });
    note(tkey, model, up.status, Date.now() - t0);
    if (!up.ok) { console.log('upstream status', up.status, model); try { await up.body.cancel(); } catch (e) {} return send(res, up.status === 429 ? 429 : 502, { error: up.status === 429 ? (tkey === 'complex' ? 'deep_busy' : 'busy') : 'upstream' }); }
    res.writeHead(200, hdr({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }));
    const dec = new TextDecoder(); let buf = '', any = false;
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5));
          const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
          const t = parts.map(p => p.text || '').join('');
          if (t) { any = true; res.write(t); }
        } catch (e) { /* ignore partial line */ }
      }
    }
    if (!any) res.write("Sorry, I couldn't answer that one. Try rephrasing it.");
    res.end();
  } catch (e) {
    note(tkey, model, 'error:' + (e && e.name), Date.now() - t0);
    if (!res.headersSent) return send(res, 502, { error: 'upstream' });
    res.end();
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && url === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) { res.writeHead(200, hdr({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })); return res.end(HTML); }
    if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, configured: !!KEY, models: MODELS, last: stats });
    res.writeHead(404, hdr({ 'content-type': 'text/plain' })); res.end('Not found');
  } catch (e) { console.error('error', e.message); if (!res.headersSent) send(res, 500, { error: 'server' }); else res.end(); }
});
process.on('uncaughtException', e => console.error('uncaught', e.message));
server.listen(PORT, '0.0.0.0', () => console.log('GBot is running on port ' + PORT + (KEY ? '' : ' (GEMINI_API_KEY is missing)')));
