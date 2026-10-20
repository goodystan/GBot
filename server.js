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

const SYSTEM = "You are GAIA 1.0, a cheerful, upbeat and knowledgeable general-purpose AI helper. You are friendly and encouraging, with light, warm humor when it fits, but always clear and accurate. If asked your name, say you are GAIA. You were built and are owned by Goody, and you are free to use. Only talk about who built or owns you when the user asks. Never bring it up on your own, including in greetings, introductions or when saying hello, and do not volunteer that you are free. If anyone asks who made, built, owns or created you, answer warmly and briefly with only the builder, for example: I'm GAIA, built by Goody. In that answer do not mention Gemini, Google, or any technology behind you. If anyone asks who Goody is, say: Goody built and owns GAIA, and I don't have other personal details about them. Never invent facts about Goody. Only if the user specifically asks which AI model or technology powers you, answer honestly that you run on Google's Gemini. Never claim that Google, OpenAI or Anthropic built GAIA itself. Use markdown (short paragraphs, lists, bold, code blocks, tables when helpful). Keep answers concise unless asked for detail.";
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
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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

// ---- Studio voices (Gemini text-to-speech). Falls back on the phone's voice in the page if unavailable. ----
// Voices are picked from Google's own voice catalog (GET /v1beta/voices) using its labels: gender, pitch and the
// description text. The catalog has no age field, so Young / Old / Child are matched on the description wording.
// Child is offered only when the catalog really contains a voice described as a child.
const MODEL_TTS = process.env.MODEL_TTS || 'gemini-3.8-flash-lite-tts';
const TTS_PER_MIN = Number(process.env.TTS_PER_MIN) || 6, TTS_PER_DAY = Number(process.env.TTS_PER_DAY) || 40, TTS_GLOBAL_DAY = Number(process.env.TTS_GLOBAL_PER_DAY) || 250;
const WHO = ['male', 'female', 'young', 'old', 'child'];
const PREFER = { male: ['Charon', 'Orus', 'Fenrir', 'Iapetus'], female: ['Kore', 'Aoede', 'Sulafat', 'Callirrhoe'], young: ['Leda', 'Puck', 'Sadachbia'], old: ['Algenib', 'Gacrux', 'Rasalgethi'], child: [] };
const BUILTIN = { male: 'Charon', female: 'Kore', young: 'Leda', old: 'Algenib' };
const KW_CHILD = /\b(child|children|kid|boy|girl|toddler|little|infant)\b/i, KW_YOUNG = /\b(young|youthful|youth|teen|teenage)\b/i, KW_OLD = /\b(old|elder|elderly|mature|aged|senior|grandfather|grandmother|seasoned)\b|gravel/i;
const ttsHits = new Map(); let ttsDay = new Date().toDateString(), ttsG = 0;
function ttsLimited(ip) {
  const now = Date.now(), d = new Date().toDateString();
  if (d !== ttsDay) { ttsDay = d; ttsHits.clear(); ttsG = 0; }
  if (ttsHits.size > 50000) ttsHits.clear();
  if (ttsG >= TTS_GLOBAL_DAY) return 'busy';
  let h = ttsHits.get(ip); if (!h) { h = { t: [], n: 0 }; ttsHits.set(ip, h); }
  h.t = h.t.filter(x => now - x < 60000);
  if (h.t.length >= TTS_PER_MIN || h.n >= TTS_PER_DAY) return 'rate_limited';
  h.t.push(now); h.n++; ttsG++; return null;
}
function findAudio(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'audio' && typeof o.data === 'string') return o;
  let r = null;
  for (const k of Object.keys(o)) { const v = o[k]; const f = Array.isArray(v) ? v.reduce((a, x) => findAudio(x) || a, null) : findAudio(v); if (f) r = f; }
  return r;
}
function wavFromPcm(buf, rate) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + buf.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(buf.length, 40);
  return Buffer.concat([h, buf]);
}
const normVoice = v => ({ id: String(v.id || v.name || ''), name: String(v.display_name || v.displayName || v.name || v.id || ''), lang: String(v.language_code || v.languageCode || ''), accent: String(v.accent || ''), gender: String(v.gender || '').toLowerCase(), pitch: String(v.pitch || '').toLowerCase(), desc: String(v.description || '') });
async function listVoices(params) {
  const out = []; let token = '';
  for (let i = 0; i < 6; i++) {
    const q = new URLSearchParams(params || {}); if (token) q.set('pageToken', token);
    const r = await fetch(BASE + '/v1beta/voices' + (q.toString() ? '?' + q.toString() : ''), { headers: { 'x-goog-api-key': KEY } });
    if (!r.ok) { if (i === 0) throw new Error('voices ' + r.status); break; }
    const j = await r.json();
    for (const v of j.voices || []) out.push(normVoice(v));
    token = j.nextPageToken || j.next_page_token || ''; if (!token) break;
  }
  return out;
}
const pubVoice = v => v && { id: v.id, name: v.name, gender: v.gender, pitch: v.pitch, language: v.lang, accent: v.accent, description: v.desc };
let voiceCache = { at: 0, ttl: 0, data: null };
async function resolveVoices() {
  if (voiceCache.data && Date.now() - voiceCache.at < voiceCache.ttl) return voiceCache.data;
  let data, ttl = 6 * 3600000;
  try {
    const seen = new Map();
    for (const params of [{}, { search: 'child' }, { search: 'young' }, { search: 'elderly' }, { search: 'mature' }]) {
      try { for (const v of await listVoices(params)) if (v.id && !seen.has(v.id)) seen.set(v.id, v); } catch (e) { if (!Object.keys(params).length) throw e; }
    }
    const all = [...seen.values()].filter(v => !v.lang || /^en/i.test(v.lang));
    if (!all.length) throw new Error('empty catalog');
    const T = v => v.name + ' ' + v.desc, kid = v => KW_CHILD.test(T(v)), yng = v => KW_YOUNG.test(T(v)), old = v => KW_OLD.test(T(v)), plain = v => !kid(v) && !yng(v) && !old(v);
    const ix = (order, p) => { const i = order.indexOf(p); return i < 0 ? 99 : i; };
    const best = (list, order, pref) => { list = list.slice().sort((a, b) => ix(order, a.pitch) - ix(order, b.pitch)); for (const n of pref) { const f = list.find(v => v.id === n || v.name === n); if (f && ix(order, f.pitch) < 99) return f; } return list[0] || null; };
    const voices = {
      male: best(all.filter(v => v.gender === 'male' && plain(v) && v.pitch !== 'high'), ['low', 'medium'], PREFER.male),
      female: best(all.filter(v => v.gender === 'female' && plain(v) && v.pitch !== 'low'), ['medium', 'high'], PREFER.female),
      young: best(all.filter(v => yng(v) && !kid(v) && !old(v) && v.pitch !== 'low'), ['medium', 'high'], PREFER.young),
      old: best(all.filter(v => old(v) && !kid(v) && v.pitch !== 'high'), ['low', 'medium'], PREFER.old),
      child: best(all.filter(v => kid(v) && v.pitch !== 'low'), ['high', 'medium'], PREFER.child)
    };
    data = { source: 'catalog', voices };
  } catch (e) {
    console.log('voice catalog unavailable:', e.message); ttl = 600000;
    const voices = { child: null }; for (const k of Object.keys(BUILTIN)) voices[k] = { id: BUILTIN[k], name: BUILTIN[k], gender: '', pitch: '', lang: '', accent: '', desc: 'Not verified: the voice catalog could not be read.' };
    data = { source: 'built-in', voices };
  }
  data.available = WHO.filter(k => data.voices[k]);
  voiceCache = { at: Date.now(), ttl, data };
  return data;
}
async function voicesRoute(res) {
  if (!KEY) return send(res, 500, { error: 'not_configured' });
  try { const d = await resolveVoices(); const voices = {}; for (const k of WHO) voices[k] = pubVoice(d.voices[k]); return send(res, 200, { source: d.source, available: d.available, voices }); }
  catch (e) { return send(res, 502, { error: 'voices_failed' }); }
}
async function tts(req, res) {
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' }); } catch (e) { return send(res, 403, { error: 'forbidden' }); } }
  if (!KEY) return send(res, 500, { error: 'not_configured' });
  if (String(req.headers['content-type'] || '').indexOf('application/json') !== 0) return send(res, 415, { error: 'bad_request' });
  if (Number(req.headers['content-length'] || 0) > 20000) return send(res, 413, { error: 'too_large' });
  const lim = ttsLimited(clientIp(req)); if (lim) return send(res, 429, { error: lim });
  let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
  const text = clip(b && b.text, 900).trim();
  if (!text || !WHO.includes(b.who)) return send(res, 400, { error: 'bad_request' });
  let voice; try { voice = (await resolveVoices()).voices[b.who]; } catch (e) { voice = null; }
  if (!voice) return send(res, 400, { error: 'no_voice' });
  const body = { model: MODEL_TTS, input: [{ type: 'user_input', content: [{ type: 'text', text }] }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: voice.id }] } };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 60000), t0 = Date.now();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const up = await fetch(BASE + '/v1beta/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body), signal: ac.signal });
    note('tts', MODEL_TTS + ' / ' + voice.id, up.status, Date.now() - t0);
    if (!up.ok) { console.log('tts upstream status', up.status, MODEL_TTS); return send(res, up.status === 429 ? 429 : 502, { error: up.status === 429 ? 'busy' : 'upstream' }); }
    const a = findAudio(await up.json());
    if (!a) return send(res, 502, { error: 'no_audio' });
    let buf = Buffer.from(a.data, 'base64');
    if (buf.slice(0, 4).toString() !== 'RIFF') buf = wavFromPcm(buf, 24000);
    res.writeHead(200, hdr({ 'content-type': 'audio/wav', 'cache-control': 'no-store' })); res.end(buf);
  } catch (e) {
    note('tts', MODEL_TTS + ' / ' + voice.id, 'error:' + (e && e.name), Date.now() - t0);
    if (!res.headersSent) return send(res, 502, { error: 'upstream' });
    res.end();
  } finally { clearTimeout(timer); }
}

// Lists the Gemini models this key can use (names only, never the key). Cached for 10 minutes.
let modelCache = { at: 0, data: null };
async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < 600000) return modelCache.data;
  const out = []; let token = '';
  for (let i = 0; i < 5; i++) {
    const r = await fetch(BASE + '/v1beta/models?pageSize=100' + (token ? '&pageToken=' + encodeURIComponent(token) : ''), { headers: { 'x-goog-api-key': KEY } });
    if (!r.ok) return { error: 'list_failed', status: r.status };
    const j = await r.json();
    for (const m of j.models || []) if ((m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini/.test(m.name)) out.push(m.name.replace('models/', ''));
    token = j.nextPageToken || ''; if (!token) break;
  }
  modelCache = { at: Date.now(), data: { count: out.length, models: out.sort() } };
  return modelCache.data;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && url === '/api/chat') return await chat(req, res);
    if (req.method === 'POST' && url === '/api/tts') return await tts(req, res);
    if (req.method === 'GET' && url === '/api/voices') return await voicesRoute(res);
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) { res.writeHead(200, hdr({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })); return res.end(HTML); }
    if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, configured: !!KEY, models: MODELS, last: stats });
    if (req.method === 'GET' && url === '/models') { if (!KEY) return send(res, 500, { error: 'not_configured' }); try { return send(res, 200, await listModels()); } catch (e) { return send(res, 502, { error: 'list_failed' }); } }
    res.writeHead(404, hdr({ 'content-type': 'text/plain' })); res.end('Not found');
  } catch (e) { console.error('error', e.message); if (!res.headersSent) send(res, 500, { error: 'server' }); else res.end(); }
});
process.on('uncaughtException', e => console.error('uncaught', e.message));
server.listen(PORT, '0.0.0.0', () => console.log('GBot is running on port ' + PORT + (KEY ? '' : ' (GEMINI_API_KEY is missing)')));
