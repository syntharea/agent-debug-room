import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';

let env, server, base;
const projectId = 'demo-agent-debug-room';
async function call(path, { method = 'GET', token, body, origin } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
before(async () => {
  const module = await import('../cloud/http.mjs').catch(() => null);
  assert.ok(module?.createRoomServer, 'the REST server must be implemented');
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Use the Firebase emulator');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: await readFile(new URL('../cloud/firestore.rules', import.meta.url), 'utf8') } });
  await env.clearFirestore();
  server = module.createRoomServer({ firebaseConfig: { projectId, apiKey: 'emulator-only-key', appId: 'emulator-test-app' }, sessionTtlMs: 2000, maxSessions: 12 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => { if (server) { await server.dispose(); await new Promise(resolve => server.close(resolve)); } await env?.cleanup(); });

test('REST implements isolated roles, joined evidence, turn gates, idempotency, revocation and deletion', async () => {
  const created = await call('/rooms', { method: 'POST', body: { topic: 'REST test', context: 'Original agents', max_turns: 2 } });
  assert.equal(created.status, 201);
  const room = created.data, path = `/rooms/${room.room_id}`;
  const owner = room.session_token;
  const join = async role => {
    const response = await call(path + '/join', { method: 'POST', body: { role, token: room.invites[role] } });
    assert.equal(response.status, 200); return response.data.session_token;
  };
  const serverToken = await join('server_agent'), client = await join('client_agent'), viewer = await join('viewer');
  let state = await call(path + '/state', { token: owner });
  assert.equal(state.data.participants.server.joined, true);
  assert.equal(state.data.participants.client.joined, true);
  assert.equal(state.data.messages.length, 0);
  for (const key of Object.values(room.invites)) assert.ok(!JSON.stringify(state.data).includes(key));
  assert.equal((await call(path + '/state')).status, 401);
  assert.equal((await call(`/rooms/${'x'.repeat(32)}/state`, { token: owner })).status, 403);
  assert.equal((await call(`/rooms/${'x'.repeat(32)}/join`, { method: 'POST', body: { role: 'server_agent', token: room.invites.server_agent } })).status, 401);
  assert.equal((await call(path + '/join', { method: 'POST', body: { role: 'owner', token: room.invites.viewer } })).status, 401);
  assert.equal((await call(path + '/control', { method: 'POST', token: viewer, body: { action: 'start' } })).status, 403);
  const message = { content: 'Server evidence', client_message_id: 'server-first' };
  assert.equal((await call(path + '/messages', { method: 'POST', token: serverToken, body: message })).data.code, 'room_paused');
  assert.equal((await call(path + '/control', { method: 'POST', token: owner, body: { action: 'start' } })).status, 200);
  assert.equal((await call(path + '/messages', { method: 'POST', token: client, body: { ...message, client_message_id: 'early' } })).data.code, 'wrong_turn');
  const first = await call(path + '/messages', { method: 'POST', token: serverToken, body: message });
  assert.equal(first.data.id, 1);
  assert.deepEqual((await call(path + '/messages', { method: 'POST', token: serverToken, body: message })).data, first.data);
  assert.equal((await call(path + '/messages', { method: 'POST', token: serverToken, body: { ...message, content: 'changed' } })).data.code, 'message_id_conflict');
  assert.equal((await call(path + '/messages', { method: 'POST', token: viewer, body: message })).status, 403);
  await call(path + '/messages', { method: 'POST', token: client, body: { content: 'Client evidence', client_message_id: 'client-first' } });
  state = await call(path + '/state?after=1', { token: viewer });
  assert.equal(state.data.paused, true); assert.deepEqual(state.data.messages.map(item => item.id), [2]);
  assert.equal((await call(path + '/state?after=-1', { token: owner })).status, 400);
  await call(path + '/invitations', { method: 'POST', token: owner, body: { role: 'viewer' } });
  assert.equal((await call(path + '/state', { token: viewer })).status, 401);
  assert.equal((await call(path + '/join', { method: 'POST', body: { role: 'viewer', token: room.invites.viewer } })).status, 401);
  assert.equal((await call(path, { method: 'DELETE', token: owner })).data.deleted, true);
  assert.equal((await call(path + '/state', { token: client })).status, 401);
});

test('REST sessions expire and invitations recover access; CORS is constrained', async () => {
  const created = (await call('/rooms', { method: 'POST', body: { topic: 'Recovery' } })).data;
  const path = `/rooms/${created.room_id}`;
  assert.equal((await call('/health', { origin: 'https://agroom.web.app' })).headers.get('access-control-allow-origin'), 'https://agroom.web.app');
  assert.equal((await call('/health', { origin: 'https://evil.test' })).status, 403);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal((await call(path + '/state', { token: created.session_token })).status, 401);
  const recovered = await call(path + '/join', { method: 'POST', body: { role: 'owner', token: created.token } });
  assert.equal(recovered.status, 200);
  assert.equal((await call(path + '/state', { token: recovered.data.session_token })).data.topic, 'Recovery');
  assert.equal((await call('/session', { method: 'DELETE', token: recovered.data.session_token })).status, 200);
  assert.equal((await call(path + '/state', { token: recovered.data.session_token })).status, 401);
});

test('REST admission is bounded before Firebase authentication and accepts the published path prefix', async () => {
  const { createRoomServer } = await import('../cloud/http.mjs');
  const bounded = createRoomServer({ firebaseConfig: { projectId, apiKey: 'emulator-only-key', appId: 'emulator-test-app' }, maxSessions: 1 });
  await new Promise(resolve => bounded.listen(0, '127.0.0.1', resolve));
  const previous = base;
  base = `http://127.0.0.1:${bounded.address().port}/agent-room/v1`;
  try {
    assert.equal((await call('/health')).status, 200);
    const created = (await call('/rooms', { method: 'POST', body: { topic: 'Bounded' } })).data;
    const capacity = await call(`/rooms/${created.room_id}/join`, { method: 'POST', body: { role: 'viewer', token: created.invites.viewer } });
    assert.equal(capacity.status, 503); assert.equal(capacity.data.code, 'session_capacity');
    await call('/session', { method: 'DELETE', token: created.session_token });
    const recovered = await call(`/rooms/${created.room_id}/join`, { method: 'POST', body: { role: 'owner', token: created.token } });
    assert.equal(recovered.status, 200);
    await call(`/rooms/${created.room_id}`, { method: 'DELETE', token: recovered.data.session_token });
  } finally { base = previous; await bounded.dispose(); await new Promise(resolve => bounded.close(resolve)); }
});

test('concurrent request headers reserve creation quota before their bodies arrive', async () => {
  const { request } = await import('node:http');
  const { createRoomServer } = await import('../cloud/http.mjs');
  const bounded = createRoomServer({ firebaseConfig: { projectId, apiKey: 'emulator-only-key', appId: 'emulator-test-app' }, creationLimit: 5 });
  await new Promise(resolve => bounded.listen(0, '127.0.0.1', resolve));
  const requests = [];
  try {
    const results = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const pending = request(`http://127.0.0.1:${bounded.address().port}/v1/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      pending.on('error', reject); pending.flushHeaders(); requests.push(pending);
    }));
    // All headers reach the server while every body is still withheld.
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const pending of requests) pending.end('{}');
    assert.deepEqual((await Promise.all(results)).sort(), [201, 201, 201, 201, 201, 429]);
  } finally { for (const pending of requests) pending.destroy(); await bounded.dispose(); await new Promise(resolve => bounded.close(resolve)); }
});

test('invalid creation input rolls back its reserved quota', async () => {
  const { createRoomServer } = await import('../cloud/http.mjs');
  const bounded = createRoomServer({ firebaseConfig: { projectId, apiKey: 'emulator-only-key', appId: 'emulator-test-app' }, creationLimit: 1 });
  await new Promise(resolve => bounded.listen(0, '127.0.0.1', resolve));
  const previous = base; base = `http://127.0.0.1:${bounded.address().port}/v1`;
  try {
    const invalid = await fetch(base + '/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid-json' });
    assert.equal(invalid.status, 400);
    assert.equal((await call('/rooms', { method: 'POST', body: { max_turns: 0 } })).status, 400);
    assert.equal((await call('/rooms', { method: 'POST', body: { topic: 'Recovered quota' } })).status, 201);
  } finally { base = previous; await bounded.dispose(); await new Promise(resolve => bounded.close(resolve)); }
});
