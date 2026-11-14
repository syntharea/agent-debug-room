import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, updateDoc, Timestamp, setLogLevel } from 'firebase/firestore';
import { openContext, createRoom, joinRoom } from '../cloud/store.mjs';

setLogLevel('silent');
const projectId = process.env.CLOUD_TEST_PROJECT || 'demo-agent-debug-room';
const config = { projectId, apiKey: 'emulator-only-key', appId: 'emulator-test-app' };
const contexts = new Set();
let env;
async function context() {
  const ctx = await openContext(config);
  contexts.add(ctx);
  return ctx;
}
async function room(overrides = {}) {
  return createRoom(await context(), { topic: 'Shared cloud room', context: 'Investigate', max_turns: 2, ...overrides });
}
async function invited(created, role) {
  return joinRoom(await context(), { roomId: created.roomId, role, token: created.invites[role] });
}
async function errorCode(promise, code, status) {
  await assert.rejects(promise, error => error.code === code && (!status || error.status === status));
}
before(async () => {
  assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, 'Run through firebase emulators:exec --only auth,firestore');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: await readFile(new URL('../cloud/firestore.rules', import.meta.url), 'utf8') } });
});
beforeEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.close())); contexts.clear();
  await env.clearFirestore();
});
after(async () => {
  await Promise.all([...contexts].map(ctx => ctx.close()));
  await env?.cleanup();
});

test('separate in-memory anonymous contexts preserve owner and viewer privileges simultaneously', async () => {
  const ownerCtx = await context();
  const created = await createRoom(ownerCtx, { topic: 'Private', context: '', max_turns: 2 });
  const viewerCtx = await context();
  assert.notEqual(ownerCtx.uid, viewerCtx.uid);
  const viewer = await joinRoom(viewerCtx, { roomId: created.roomId, role: 'viewer', token: created.invites.viewer });
  assert.equal((await viewer.request('/api/state')).role, 'viewer');
  await errorCode(viewer.request('/api/control', { action: 'start' }), 'owner_required', 403);
  assert.equal((await created.session.request('/api/control', { action: 'start' })).paused, false);
  const state = await viewer.request('/api/state');
  assert.equal(state.topic, 'Private');
  assert.equal(state.messages.length, 0);
  assert.equal(state.message_limit, 100);
  for (const token of Object.values(created.invites)) assert.ok(!JSON.stringify(state).includes(token));
});

test('SDK preserves the bridge API, idempotency, cursors and role-specific errors', async () => {
  const created = await room();
  const owner = created.session;
  const server = await invited(created, 'server_agent');
  const client = await invited(created, 'client_agent');
  await errorCode(server.request('/api/agent/messages', { content: 'First', client_message_id: 'first' }), 'room_paused', 409);
  await owner.request('/api/control', { action: 'start' });
  await errorCode(client.request('/api/agent/messages', { content: 'Too early', client_message_id: 'early' }), 'wrong_turn', 409);
  const first = await server.request('/api/agent/messages', { content: 'First', client_message_id: 'first' });
  assert.equal(first.id, 1); assert.equal(first.role, 'server');
  await owner.request('/api/messages', { content: 'Observation', client_message_id: 'note' });
  await client.request('/api/agent/messages', { content: 'Second', client_message_id: 'second' });
  const retry = await server.request('/api/agent/messages', { content: 'First', client_message_id: 'first' });
  assert.deepEqual(retry, first);
  await errorCode(server.request('/api/agent/messages', { content: 'Changed', client_message_id: 'first' }), 'message_id_conflict', 409);
  const state = await owner.request('/api/state?after=1');
  assert.deepEqual(state.messages.map(message => message.id), [2, 3]);
  assert.equal(state.turns_used, 2); assert.equal(state.paused, true);
  assert.equal(state.participants.server.last_seen, first.created_at);
  assert.equal((await owner.request('/api/control', { action: 'start' })).turns_used, 0);
  await errorCode(owner.request('/api/state?after=-1'), 'invalid_cursor', 400);
  await errorCode(owner.request('/api/messages', { content: 'x', client_message_id: '../bad' }), 'invalid_message_id', 400);
  await errorCode(owner.request('/api/config', { max_turns: 21 }), 'invalid_max_turns', 400);
  await errorCode(owner.request('/api/unknown'), 'not_found', 404);
});

test('a capability restores owner access and rotating another role revokes its previous session', async () => {
  const created = await room();
  const restored = await invited(created, 'owner');
  const viewer = await invited(created, 'viewer');
  const credentials = await restored.request('/api/invite');
  assert.equal(credentials.room_id, created.roomId);
  assert.equal(credentials.owner_token, created.token);
  const rotated = await restored.request('/api/invite', { role: 'viewer' });
  assert.notEqual(rotated.viewer_token, created.invites.viewer);
  await errorCode(viewer.request('/api/state'), 'unauthorized', 401);
  const replacement = await joinRoom(await context(), { roomId: created.roomId, role: 'viewer', token: rotated.viewer_token });
  assert.equal((await replacement.request('/api/state')).role, 'viewer');
  await errorCode(joinRoom(await context(), { roomId: created.roomId, role: 'owner', token: created.invites.viewer }), 'invalid_invite', 401);
});

test('subscription emits coherent complete state after new messages without polling', async () => {
  const created = await room();
  const viewer = await invited(created, 'viewer');
  const states = [];
  let waitForFirst, waitForMessage;
  const initial = new Promise(resolve => { waitForFirst = resolve; });
  const updated = new Promise(resolve => { waitForMessage = resolve; });
  const failure = new Promise((_, reject) => {
    const off = viewer.subscribe(state => {
      states.push(state);
      assert.equal(state.messages.length, state.message_count);
      if (state.messages.length === 0) waitForFirst();
      if (state.messages.length === 1) { off(); waitForMessage(state); }
    }, reject);
  });
  const timeout = AbortSignal.timeout(15000);
  const timed = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Subscription timed out')), { once: true }));
  await Promise.race([initial, failure, timed]);
  await created.session.request('/api/messages', { content: 'Observable', client_message_id: 'observed' });
  const state = await Promise.race([updated, failure, timed]);
  assert.equal(state.messages[0].content, 'Observable');
  assert.equal(states.at(-1).message_count, 1);
});

test('expired SDK sessions can export but cannot mutate; interrupted deletion recovers in a new UID', async () => {
  const created = await room();
  await invited(created, 'viewer');
  await invited(created, 'server_agent');
  await created.session.request('/api/messages', { content: 'Retained evidence', client_message_id: 'evidence' });
  await env.withSecurityRulesDisabled(async ctx => updateDoc(doc(ctx.firestore(), `rooms/${created.roomId}`), { created_at: Timestamp.fromMillis(Date.now() - 8 * 86400000) }));
  const state = await created.session.request('/api/state');
  assert.equal(state.expired, true); assert.equal(state.messages.length, 1);
  await errorCode(created.session.request('/api/messages', { content: 'Late', client_message_id: 'late' }), 'room_expired', 409);
  await env.withSecurityRulesDisabled(async ctx => updateDoc(doc(ctx.firestore(), `rooms/${created.roomId}`), { deleting: true }));
  await created.session.close();
  const recovery = await invited(created, 'owner');
  await recovery.deleteRoom();
  await env.withSecurityRulesDisabled(async ctx => {
    const firestore = ctx.firestore();
    assert.equal((await getDoc(doc(firestore, `rooms/${created.roomId}`))).exists(), false);
    for (const child of ['messages', 'members', 'secrets']) assert.equal((await getDocs(collection(firestore, `rooms/${created.roomId}/${child}`))).size, 0);
  });
});

test('rotating an invitation terminates an already active Firestore subscription', async () => {
  const created = await room();
  const viewer = await invited(created, 'viewer');
  let ready, revoked;
  const initial = new Promise(resolve => { ready = resolve; });
  const denied = new Promise(resolve => { revoked = resolve; });
  const off = viewer.subscribe(() => ready(), error => revoked(error));
  const timeout = AbortSignal.timeout(15000);
  const timed = new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Revocation timed out')), { once: true }));
  await Promise.race([initial, timed]);
  await created.session.request('/api/invite', { role: 'viewer' });
  const error = await Promise.race([denied, timed]);
  assert.equal(error.code, 'unauthorized');
  off();
});

test('concurrent retries of one message ID return one durable message and consume only one turn', async () => {
  const created = await room();
  const first = await invited(created, 'server_agent');
  const second = await invited(created, 'server_agent');
  await created.session.request('/api/control', { action: 'start' });
  const results = await Promise.allSettled([first, second].map(session => session.request('/api/agent/messages', { content: 'Exactly once', client_message_id: 'concurrent-retry' })));
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(results[0].value, results[1].value);
  const state = await created.session.request('/api/state');
  assert.equal(state.turns_used, 1); assert.equal(state.messages.length, 1);
});

test('full-room deletion clears one hundred message documents within Rules access budgets', async () => {
  const created = await room();
  // Boundary setup avoids 100 irrelevant appends; deletion itself uses normal authenticated SDK writes.
  await env.withSecurityRulesDisabled(async ctx => {
    const firestore = ctx.firestore();
    const { writeBatch } = await import('firebase/firestore');
    const batch = writeBatch(firestore);
    for (let i = 1; i <= 100; i++) batch.set(doc(firestore, `rooms/${created.roomId}/messages/bulk-${i}`), { seq: i, role: 'human', content: 'Evidence', client_message_id: `bulk-${i}`, created_at: Timestamp.now() });
    batch.update(doc(firestore, `rooms/${created.roomId}`), { seq: 100, last_message_id: 'bulk-100' });
    await batch.commit();
  });
  await created.session.deleteRoom();
  await env.withSecurityRulesDisabled(async ctx => {
    assert.equal((await getDoc(doc(ctx.firestore(), `rooms/${created.roomId}`))).exists(), false);
    assert.equal((await getDocs(collection(ctx.firestore(), `rooms/${created.roomId}/messages`))).size, 0);
  });
});
