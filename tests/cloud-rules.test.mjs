import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp, Timestamp, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');
const PROJECT = process.env.CLOUD_TEST_PROJECT || 'demo-agent-debug-room';
const RID = 'room_00000000000000000001';
const KEYS = { owner: 'a'.repeat(43), viewer: 'b'.repeat(43), server_agent: 'c'.repeat(43), client_agent: 'd'.repeat(43) };
let env;
const db = uid => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const roomRef = (firestore, rid = RID) => doc(firestore, `rooms/${rid}`);
const memberRef = (firestore, uid, rid = RID) => doc(firestore, `rooms/${rid}/members/${uid}`);
const keysRef = (firestore, rid = RID) => doc(firestore, `rooms/${rid}/secrets/keys`);
const messageRef = (firestore, id, rid = RID) => doc(firestore, `rooms/${rid}/messages/${id}`);
function initialRoom(uid, extra = {}) {
  return { version: 1, creator_uid: uid, created_at: serverTimestamp(), topic: 'Test room', context: '', max_turns: 4,
    paused: true, next_speaker: 'server', turns_used: 0, seq: 0, last_message_id: '', deleting: false, ...extra };
}
async function create(uid = 'owner', rid = RID, keys = KEYS) {
  const firestore = db(uid);
  await runTransaction(firestore, async tx => {
    const quotaRef = doc(firestore, `creation_quotas/${uid}`);
    const old = await tx.get(quotaRef);
    const reset = !old.exists() || old.data().window_start.toMillis() <= Date.now() - 86400000;
    tx.set(quotaRef, { window_start: reset ? serverTimestamp() : old.data().window_start, count: reset ? 1 : old.data().count + 1, last_room_id: rid });
    tx.set(roomRef(firestore, rid), initialRoom(uid));
    tx.set(keysRef(firestore, rid), keys);
    tx.set(memberRef(firestore, uid, rid), { role: 'owner', token: keys.owner, joined_at: serverTimestamp() });
  });
  return firestore;
}
async function join(uid, role, token = KEYS[role], rid = RID) {
  const firestore = db(uid);
  await setDoc(memberRef(firestore, uid, rid), { role, token, joined_at: serverTimestamp() });
  return firestore;
}
async function seedRoom(fields) {
  await env.withSecurityRulesDisabled(async ctx => updateDoc(roomRef(ctx.firestore()), fields));
}
async function append(firestore, role, id, content = 'Hello') {
  return runTransaction(firestore, async tx => {
    const ref = messageRef(firestore, id);
    const existing = await tx.get(ref);
    if (existing.exists()) {
      const previous = existing.data();
      if (previous.role !== role || previous.content !== content) throw new Error('message_id_conflict');
      return previous;
    }
    const room = (await tx.get(roomRef(firestore))).data();
    const msg = { seq: room.seq + 1, role, content, client_message_id: id, created_at: serverTimestamp() };
    const next = { seq: msg.seq, last_message_id: id };
    if (role !== 'human') Object.assign(next, { turns_used: room.turns_used + 1, next_speaker: role === 'server' ? 'client' : 'server', paused: room.turns_used + 1 >= room.max_turns });
    tx.set(ref, msg);
    tx.update(roomRef(firestore), next);
    return msg;
  });
}
before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  const rules = await readFile(new URL('../cloud/firestore.rules', import.meta.url), 'utf8').catch(() => "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }");
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port), rules } });
});
beforeEach(async () => env.clearFirestore());
after(async () => env?.cleanup());

test('atomic creation permits the owner and all four roles, but a guessed room ID grants nothing', async () => {
  const owner = await create();
  await assertSucceeds(getDoc(roomRef(owner)));
  for (const role of ['viewer', 'server_agent', 'client_agent']) {
    const member = await join(role, role);
    await assertSucceeds(getDoc(roomRef(member)));
  }
  await assertFails(getDoc(roomRef(db('stranger'))));
  await assertFails(getDoc(roomRef(db())));
  await assertFails(getDocs(collection(owner, 'rooms')));
  await assertFails(getDocs(collection(db('stranger'), 'rooms')));
});

test('bootstrap requires the quota, owner membership and all four distinct private keys', async () => {
  const firestore = db('owner');
  await assertFails(setDoc(roomRef(firestore), initialRoom('owner')));
  await assertFails(setDoc(memberRef(firestore, 'owner'), { role: 'owner', token: KEYS.owner, joined_at: serverTimestamp() }));
  await assertFails(create('owner', RID, { ...KEYS, client_agent: KEYS.owner }));
});

test('only an owner can read keys or other memberships; invalid invitations cannot join', async () => {
  const owner = await create();
  const viewer = await join('viewer', 'viewer');
  await assertSucceeds(getDoc(keysRef(owner)));
  await assertSucceeds(getDocs(collection(owner, `rooms/${RID}/members`)));
  await assertSucceeds(getDoc(memberRef(viewer, 'viewer')));
  await assertFails(getDoc(keysRef(viewer)));
  await assertFails(getDocs(collection(viewer, `rooms/${RID}/secrets`)));
  await assertFails(getDoc(memberRef(viewer, 'owner')));
  await assertFails(getDocs(collection(viewer, `rooms/${RID}/members`)));
  await assertFails(join('forged', 'owner', KEYS.viewer));
  await assertFails(join('wrong', 'viewer', 'z'.repeat(43)));
  await assertFails(updateDoc(memberRef(viewer, 'viewer'), { role: 'owner', token: KEYS.owner }));
});

test('owner capability restores in a new UID; ownership and tokens never cross room boundaries', async () => {
  await create();
  const restored = await join('restored', 'owner');
  await assertSucceeds(updateDoc(roomRef(restored), { paused: false }));
  const otherRid = 'room_00000000000000000002';
  const otherKeys = Object.fromEntries(Object.entries(KEYS).map(([role, key]) => [role, key.toUpperCase()]));
  await create('owner-two', otherRid, otherKeys);
  await assertFails(getDoc(roomRef(restored, otherRid)));
  await assertFails(join('cross-room', 'owner', KEYS.owner, otherRid));
  await assertFails(setDoc(memberRef(restored, 'somebody-else'), { role: 'owner', token: KEYS.owner, joined_at: serverTimestamp() }));
});

test('agents alternate, human notes preserve turns, and the exact retry returns the original message', async () => {
  const owner = await create();
  const server = await join('server', 'server_agent');
  const client = await join('client', 'client_agent');
  await updateDoc(roomRef(owner), { paused: false });
  await assertSucceeds(append(server, 'server', 'first'));
  await assertSucceeds(append(owner, 'human', 'note'));
  await assertSucceeds(append(client, 'client', 'second'));
  const retry = await append(server, 'server', 'first');
  assert.equal(retry.seq, 1);
  await assert.rejects(append(server, 'server', 'first', 'Changed'), /message_id_conflict/);
  const data = (await getDoc(roomRef(owner))).data();
  assert.equal(data.seq, 3);
  assert.equal(data.turns_used, 2);
  assert.equal(data.next_speaker, 'server');
  await assertFails(updateDoc(messageRef(owner, 'first'), { content: 'Changed' }));
  await assertFails(deleteDoc(messageRef(owner, 'first')));
});

test('viewer cannot impersonate an agent or owner and an owner cannot forge sequence progress', async () => {
  const owner = await create();
  const viewer = await join('viewer', 'viewer');
  await updateDoc(roomRef(owner), { paused: false });
  await assertFails(append(viewer, 'server', 'forged-agent'));
  await assertFails(append(viewer, 'human', 'forged-owner'));
  await assertFails(updateDoc(roomRef(viewer), { paused: true }));
  await assertFails(updateDoc(roomRef(owner), { seq: 1, last_message_id: 'absent' }));
  await assertFails(updateDoc(roomRef(owner), { turns_used: 2 }));
  await assertFails(updateDoc(roomRef(owner), { next_speaker: 'client' }));
  await assertFails(updateDoc(roomRef(owner), { created_at: Timestamp.now() }));
});

test('head binding rejects two different messages in one increment and a message without a head write', async () => {
  const owner = await create();
  const batch = writeBatch(owner);
  for (const id of ['one', 'two']) batch.set(messageRef(owner, id), { seq: 1, role: 'human', content: 'Hello', client_message_id: id, created_at: serverTimestamp() });
  batch.update(roomRef(owner), { seq: 1, last_message_id: 'one' });
  await assertFails(batch.commit());
  await assertFails(setDoc(messageRef(owner, 'alone'), { seq: 1, role: 'human', content: 'Hello', client_message_id: 'alone', created_at: serverTimestamp() }));
  assert.equal((await getDoc(roomRef(owner))).data().seq, 0);
});

test('concurrent transactions cannot double-use an agent turn', async () => {
  const owner = await create();
  const first = await join('server-one', 'server_agent');
  const second = await join('server-two', 'server_agent');
  await updateDoc(roomRef(owner), { paused: false });
  const results = await Promise.allSettled([append(first, 'server', 'race-one'), append(second, 'server', 'race-two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await getDoc(roomRef(owner))).data().turns_used, 1);
  assert.equal((await getDocs(collection(owner, `rooms/${RID}/messages`))).size, 1);
});

test('paused, wrong turn, exhausted budgets and resume semantics are enforced by Rules', async () => {
  const owner = await create();
  const server = await join('server', 'server_agent');
  const client = await join('client', 'client_agent');
  await assertFails(append(server, 'server', 'paused'));
  await updateDoc(roomRef(owner), { max_turns: 1, paused: true });
  await updateDoc(roomRef(owner), { paused: false });
  await assertFails(append(client, 'client', 'wrong-turn'));
  await append(server, 'server', 'one-turn');
  let state = (await getDoc(roomRef(owner))).data();
  assert.equal(state.paused, true);
  assert.equal(state.turns_used, 1);
  await assertFails(append(client, 'client', 'over-budget'));
  await assertFails(updateDoc(roomRef(owner), { paused: false }));
  await assertSucceeds(updateDoc(roomRef(owner), { paused: false, turns_used: 0 }));
  await assertSucceeds(append(client, 'client', 'new-budget'));
});

test('seven-day expiry is read-only but still permits owner recovery and explicit deletion', async () => {
  const owner = await create();
  await seedRoom({ created_at: Timestamp.fromMillis(Date.now() - 8 * 86400000) });
  await assertSucceeds(getDoc(roomRef(owner)));
  const restored = await join('restored', 'owner');
  await assertSucceeds(getDoc(roomRef(restored)));
  await assertFails(append(owner, 'human', 'late'));
  await assertFails(updateDoc(roomRef(owner), { topic: 'Too late' }));
  await assertFails(updateDoc(roomRef(owner), { paused: false }));
  await assertFails(updateDoc(keysRef(owner), { viewer: 'e'.repeat(43) }));
  await assertSucceeds(updateDoc(roomRef(owner), { deleting: true }));
  await assertFails(join('late-join', 'viewer'));
  await assertFails(updateDoc(roomRef(owner), { deleting: false }));
  await assertSucceeds(deleteDoc(memberRef(owner, 'restored')));
  const batch = writeBatch(owner);
  batch.delete(memberRef(owner, 'owner')); batch.delete(keysRef(owner)); batch.delete(roomRef(owner));
  await assertSucceeds(batch.commit());
});

test('the hundredth message succeeds and the next is rejected even for the owner', async () => {
  const owner = await create();
  await seedRoom({ seq: 99, last_message_id: 'previous' });
  await assertSucceeds(append(owner, 'human', 'hundred'));
  await assertFails(append(owner, 'human', 'hundred-one'));
  assert.equal((await getDoc(roomRef(owner))).data().seq, 100);
});

test('server validates text lengths, IDs, config and all immutable metadata', async () => {
  const owner = await create();
  await assertFails(append(owner, 'human', 'blank', '   '));
  await assertFails(append(owner, 'human', 'too-long', 'x'.repeat(16001)));
  await assertFails(append(owner, 'human', 'invalid.id'));
  await assertFails(updateDoc(roomRef(owner), { topic: 'x'.repeat(201) }));
  await assertFails(updateDoc(roomRef(owner), { context: 'x'.repeat(24001) }));
  await assertFails(updateDoc(roomRef(owner), { max_turns: 21 }));
  await assertFails(updateDoc(roomRef(owner), { max_turns: 0 }));
  await assertFails(updateDoc(roomRef(owner), { extra: true }));
  await assertSucceeds(append(owner, 'human', 'unicode', '你好 🌍'));
});

test('rotation immediately revokes existing members and does not permit owner key replacement', async () => {
  const owner = await create();
  const viewer = await join('viewer', 'viewer');
  await updateDoc(keysRef(owner), { viewer: 'e'.repeat(43) });
  await assertFails(getDoc(roomRef(viewer)));
  await assertFails(getDocs(collection(viewer, `rooms/${RID}/messages`)));
  await assertFails(join('old-key', 'viewer'));
  const fresh = await join('new-key', 'viewer', 'e'.repeat(43));
  await assertSucceeds(getDoc(roomRef(fresh)));
  await assertFails(updateDoc(keysRef(owner), { owner: 'f'.repeat(43) }));
  await assertFails(updateDoc(keysRef(owner), { viewer: KEYS.owner }));
});

test('one UID creates at most five rooms per rolling day and cannot delete or forge its quota', async () => {
  for (let i = 1; i <= 5; i++) await create('owner', `quota_room_0000000000000${i}`);
  await assertFails(create('owner', 'quota_room_00000000000006'));
  const owner = db('owner');
  const quota = doc(owner, 'creation_quotas/owner');
  await assertFails(updateDoc(quota, { count: 1 }));
  await assertFails(deleteDoc(quota));
  await assertFails(getDoc(doc(db('stranger'), 'creation_quotas/owner')));
  await env.withSecurityRulesDisabled(async ctx => updateDoc(doc(ctx.firestore(), 'creation_quotas/owner'), { window_start: Timestamp.fromMillis(Date.now() - 25 * 3600000) }));
  await assertSucceeds(create('owner', 'quota_room_00000000000007'));
  assert.equal((await getDoc(quota)).data().count, 1);
});

test('one quota increment cannot bootstrap two rooms in a malicious batch', async () => {
  const owner = db('owner');
  const batch = writeBatch(owner);
  const second = 'room_00000000000000000002';
  for (const rid of [RID, second]) {
    batch.set(roomRef(owner, rid), initialRoom('owner'));
    batch.set(keysRef(owner, rid), KEYS);
    batch.set(memberRef(owner, 'owner', rid), { role: 'owner', token: KEYS.owner, joined_at: serverTimestamp() });
  }
  batch.set(doc(owner, 'creation_quotas/owner'), { window_start: serverTimestamp(), count: 1, last_room_id: RID });
  await assertFails(batch.commit());
});

test('Unicode codepoint limits accept CJK and emoji equally and reject oversized writes directly in Rules', async () => {
  const owner = await create();
  for (const [name, character] of [['cjk', '界'], ['emoji', '😀']]) {
    await assertSucceeds(append(owner, 'human', `${name}-at-limit`, character.repeat(16000)));
    await assertFails(append(owner, 'human', `${name}-over-limit`, character.repeat(16001)));
    await assertSucceeds(updateDoc(roomRef(owner), { topic: character.repeat(200), context: character.repeat(24000) }));
    await assertFails(updateDoc(roomRef(owner), { topic: character.repeat(201) }));
    await assertFails(updateDoc(roomRef(owner), { context: character.repeat(24001) }));
  }
});
