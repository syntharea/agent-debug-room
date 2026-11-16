import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { openContext, createRoom, joinRoom } from './store.mjs';
import { setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const ORIGINS = new Set(['https://agroom.web.app', 'https://agent-debug-room.web.app', 'https://agroom.firebaseapp.com', 'https://agent-debug-room.firebaseapp.com', 'https://agent-debug-room-syntharea.web.app', 'https://agent-debug-room-syntharea.firebaseapp.com']);
function fail(status, code, error) { return Object.assign(new Error(error), { status, data: { code, error } }); }
function allowedOrigin(origin) {
  if (ORIGINS.has(origin)) return true;
  try { const url = new URL(origin); return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}
async function readBody(request) {
  if (!request.headers['content-type']?.split(';')[0].trim().match(/^application\/json$/i)) throw fail(415, 'invalid_content_type', 'Use Content-Type: application/json');
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw fail(413, 'body_too_large', 'The request body is too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'invalid_json', 'The request body must be JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid_json', 'The request body must be a JSON object');
  return value;
}

// This gateway uses normal anonymous Firebase clients. Every operation remains
// subject to Firestore Rules; there are no administrator credentials here.
export function createRoomServer({ firebaseConfig, sessionTtlMs = 30 * 60 * 1000, maxSessions = 128, trustProxy = false, creationLimit = 5 } = {}) {
  const sessions = new Map(), creations = new Map(), admissions = new Map();
  let pending = 0, disposed = false;
  function sweep() {
    const now = Date.now();
    for (const [token, entry] of sessions) if (!entry.active && now >= entry.expires) drop(token);
    for (const registry of [creations, admissions]) for (const [ip, quota] of registry) if (now >= quota.reset) registry.delete(ip);
  }
  function drop(token) {
    const entry = sessions.get(token);
    if (!entry) return;
    sessions.delete(token);
    return entry.session.close().catch(() => {});
  }
  const timer = setInterval(sweep, Math.min(sessionTtlMs, 60000)); timer.unref();
  function requestIp(request) {
    const forwarded = trustProxy ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return isIP(forwarded) ? forwarded : request.socket.remoteAddress;
  }
  function admit(request) {
    sweep();
    const ip = requestIp(request);
    let quota = admissions.get(ip);
    if (!quota) {
      if (admissions.size >= 2048) throw fail(429, 'rate_limited', 'Try joining again later');
      quota = { count: 0, reset: Date.now() + 600000 }; admissions.set(ip, quota);
    }
    if (++quota.count > 60) throw fail(429, 'rate_limited', 'Too many join attempts; try again later');
  }
  async function open(body, roomId) {
    sweep();
    if (disposed || sessions.size + pending >= maxSessions) throw fail(503, 'session_capacity', 'The service is busy; try again later');
    pending++;
    let context;
    try {
      context = await openContext(firebaseConfig);
      const result = roomId ? { session: await joinRoom(context, { ...body, roomId }) } : await createRoom(context, body);
      const sessionToken = randomBytes(32).toString('base64url');
      sessions.set(sessionToken, { session: result.session, expires: Date.now() + sessionTtlMs, active: 0 });
      return { room_id: result.session.roomId, role: result.session.role, ...(roomId ? {} : { token: result.token, invites: result.invites }), session_token: sessionToken, expires_in: Math.floor(sessionTtlMs / 1000) };
    } catch (error) { await context?.close().catch(() => {}); throw error; }
    finally { pending--; }
  }
  function authenticate(request, roomId) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '');
    const token = match?.[1], entry = sessions.get(token);
    if (!entry || Date.now() >= entry.expires && !entry.active) {
      if (entry) drop(token);
      throw fail(401, 'session_expired', 'Join with your invitation to obtain a new session');
    }
    if (roomId && entry.session.roomId !== roomId) throw fail(403, 'room_mismatch', 'This session belongs to another room');
    entry.expires = Date.now() + sessionTtlMs;
    return { token, entry };
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    let used;
    function send(status, value) { response.writeHead(status); response.end(JSON.stringify(value)); }
    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!allowedOrigin(origin)) throw fail(403, 'origin_not_allowed', 'This browser origin is not allowed');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname.replace(/^\/agent-room(?=\/v1(?:\/|$))/, '');
      if ((path === '/health' || path === '/v1/health') && request.method === 'GET') { send(200, { ok: true }); return; }
      if (path === '/v1/rooms' && request.method === 'POST') {
        sweep();
        admit(request);
        const ip = requestIp(request);
        let quota = creations.get(ip);
        if (!quota) {
          if (creations.size >= 2048) throw fail(429, 'creation_limit', 'Try creating a room later');
          quota = { count: 0, reset: Date.now() + 86400000 }; creations.set(ip, quota);
        }
        if (quota.count >= creationLimit) throw fail(429, 'creation_limit', 'This network has reached its daily room-creation limit');
        const body = await readBody(request);
        quota.count++;
        try { send(201, await open(body)); } catch (error) { quota.count--; throw error; }
        return;
      }
      const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{20,64})(?:\/(join|state|messages|config|control|invitations))?$/.exec(path);
      if (match?.[2] === 'join' && request.method === 'POST') { admit(request); send(200, await open(await readBody(request), match[1])); return; }
      if (!match && !(path === '/v1/session' && request.method === 'DELETE')) throw fail(404, 'not_found', 'Endpoint not found');
      used = authenticate(request, match?.[1]);
      const { entry, token } = used;
      entry.active++;
      if (path === '/v1/session') { await drop(token); send(200, { closed: true }); return; }
      const endpoint = match[2], method = request.method;
      let result;
      if (!endpoint && method === 'DELETE') { result = await entry.session.deleteRoom(); await drop(token); }
      else if (endpoint === 'state' && method === 'GET') result = await entry.session.request(`/api/state${url.search}`);
      else if (endpoint === 'messages' && method === 'POST') result = await entry.session.request(entry.session.role === 'owner' ? '/api/messages' : '/api/agent/messages', await readBody(request));
      else if (endpoint === 'config' && ['GET', 'POST'].includes(method)) result = await entry.session.request('/api/config', method === 'POST' ? await readBody(request) : undefined);
      else if (endpoint === 'control' && method === 'POST') result = await entry.session.request('/api/control', await readBody(request));
      else if (endpoint === 'invitations' && ['GET', 'POST'].includes(method)) result = await entry.session.request('/api/invite', method === 'POST' ? await readBody(request) : undefined);
      else throw fail(405, 'method_not_allowed', 'This method is not supported for the endpoint');
      send(200, result);
    } catch (error) {
      const status = error.status || 500;
      send(status, error.data || { code: 'internal_error', error: 'The service could not process this request' });
    } finally { if (used) used.entry.active--; }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.dispose = async () => { disposed = true; clearInterval(timer); await Promise.all([...sessions.keys()].map(drop)); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let firebaseConfig;
  try { firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || ''); } catch { throw new Error('FIREBASE_CONFIG must contain the public Firebase web config as JSON'); }
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.appId) throw new Error('FIREBASE_CONFIG requires apiKey, projectId and appId');
  const server = createRoomServer({ firebaseConfig, trustProxy: process.env.TRUST_PROXY === '1' });
  const port = Number(process.env.PORT || 4100);
  server.listen(port, '0.0.0.0', () => console.log(`Agent Room REST API listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(async () => { await server.dispose(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); });
}
