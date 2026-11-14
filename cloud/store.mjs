import { initializeApp, deleteApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore, memoryLocalCache, connectFirestoreEmulator, terminate,
  doc, collection, query, orderBy, where, limit, getDocFromServer, getDocsFromServer,
  runTransaction, writeBatch, serverTimestamp, onSnapshot,
} from 'firebase/firestore';

const DAY = 86400000;
const ROLES = ['owner', 'viewer', 'server_agent', 'client_agent'];
const NAMES = { human: 'Host', server: 'Server agent', client: 'Client agent' };
const DEFAULT_CONFIG = { topic: 'Cross-agent debugging', context: '', max_turns: 20 };

function fail(code, status, message) {
  const error = new Error(message);
  Object.assign(error, { code, status, data: { code, error: message } });
  return error;
}
function mapped(error) {
  if (error?.data?.code && error.status) return error;
  const code = String(error?.code || '').replace(/^(firestore|auth)\//, '');
  if (['permission-denied', 'unauthenticated', 'invalid-user-token', 'user-token-expired'].includes(code)) {
    return fail('unauthorized', 401, 'A valid room invitation is required');
  }
  if (['resource-exhausted', 'too-many-requests', 'quota-exceeded'].includes(code)) {
    return fail('resource_exhausted', 429, 'The service quota has been reached; try again later');
  }
  if (['unavailable', 'aborted', 'deadline-exceeded', 'network-request-failed'].includes(code)) {
    return fail('unavailable', 503, 'The service is temporarily unavailable');
  }
  return fail('internal_error', 500, 'The service could not process this request');
}
function randomKey(bytes = 32) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || [...value].length > maximum || (!allowEmpty && !value.trim())) {
    throw fail('invalid_text', 400, 'Text has invalid content or length');
  }
  return value;
}
function configValue(body, previous = DEFAULT_CONFIG) {
  if (!object(body) || Object.keys(body).some(key => !Object.hasOwn(DEFAULT_CONFIG, key))) {
    throw fail('invalid_config', 400, 'Configuration only supports topic, context and max_turns');
  }
  const result = { ...previous, ...body };
  text(result.topic, 200); text(result.context, 24000, true);
  if (!Number.isInteger(result.max_turns) || result.max_turns < 1 || result.max_turns > 20) {
    throw fail('invalid_max_turns', 400, 'max_turns must be an integer between 1 and 20');
  }
  return result;
}
function canonicalRole(role) { return role === 'server' || role === 'client' ? `${role}_agent` : role; }
function available(ctx) {
  if (ctx._closed) throw fail('unauthorized', 401, 'This session has closed');
}
function unbound(ctx) {
  available(ctx);
  if (ctx._session) throw fail('invalid_invite', 400, 'Open a separate context for each room session');
}
function assertMutable(room) {
  if (room.deleting) throw fail('room_deleting', 409, 'This room is being deleted');
  if (Date.now() >= room.created_at.toMillis() + 7 * DAY) throw fail('room_expired', 409, 'This room is read-only after seven days');
}
function iso(timestamp) { return timestamp?.toDate().toISOString() || null; }
function messageValue(data) {
  return { id: data.seq, role: data.role, name: NAMES[data.role], content: data.content, created_at: iso(data.created_at) };
}
function stateValue(roomId, role, room, messages, after = 0) {
  const expires = room.created_at.toMillis() + 7 * DAY;
  const expired = Date.now() >= expires;
  const participants = { server: { last_seen: null }, client: { last_seen: null } };
  for (const message of messages) if (participants[message.role]) participants[message.role].last_seen = iso(message.created_at);
  return {
    title: 'Agent Debug Room', mode: 'agent_bridge', role, topic: room.topic, context: room.context,
    paused: room.paused || expired || room.deleting, running: false, next_speaker: room.next_speaker,
    turns_used: room.turns_used, max_turns: room.max_turns, participants,
    messages: messages.filter(message => message.seq > after).map(messageValue),
    room_id: roomId, created_at: iso(room.created_at), expires_at: new Date(expires).toISOString(),
    expired, message_count: room.seq, message_limit: 100, deleting: room.deleting,
  };
}

export async function openContext(firebaseConfig, options = {}) {
  const app = initializeApp(firebaseConfig, `room-${randomKey(12)}`);
  let db;
  try {
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
    const env = typeof process !== 'undefined' ? process.env || {} : {};
    const emulators = options.emulators || {};
    const authHost = emulators.auth || (env.FIREBASE_AUTH_EMULATOR_HOST && `http://${env.FIREBASE_AUTH_EMULATOR_HOST}`);
    const firestoreAddress = env.FIRESTORE_EMULATOR_HOST?.split(':');
    const firestoreHost = emulators.firestore || (firestoreAddress && { host: firestoreAddress[0], port: Number(firestoreAddress[1]) });
    if (authHost) connectAuthEmulator(auth, authHost, { disableWarnings: true });
    if (firestoreHost) connectFirestoreEmulator(db, firestoreHost.host, firestoreHost.port);
    const { user } = await signInAnonymously(auth);
    const ctx = { app, auth, db, uid: user.uid, _closed: false, _session: null, _listeners: new Set() };
    let closing;
    ctx.close = () => {
      if (closing) return closing;
      ctx._closed = true;
      for (const off of ctx._listeners) off();
      closing = terminate(db).finally(() => deleteApp(app));
      return closing;
    };
    return ctx;
  } catch (error) {
    if (db) await terminate(db).catch(() => {});
    await deleteApp(app).catch(() => {});
    throw mapped(error);
  }
}

export async function createRoom(ctx, configuration = {}) {
  unbound(ctx);
  const settings = configValue(configuration);
  const roomId = randomKey(24);
  const invites = Object.fromEntries(ROLES.map(role => [role, randomKey()]));
  try {
    await runTransaction(ctx.db, async tx => {
      const quotaRef = doc(ctx.db, 'creation_quotas', ctx.uid);
      const quotaSnapshot = await tx.get(quotaRef);
      const old = quotaSnapshot.data();
      const reset = !old || Date.now() >= old.window_start.toMillis() + DAY;
      if (!reset && old.count >= 5) throw fail('creation_limit', 429, 'This anonymous session has created five rooms in 24 hours');
      tx.set(quotaRef, { window_start: reset ? serverTimestamp() : old.window_start, count: reset ? 1 : old.count + 1, last_room_id: roomId });
      tx.set(doc(ctx.db, 'rooms', roomId), {
        version: 1, creator_uid: ctx.uid, created_at: serverTimestamp(), ...settings,
        paused: true, next_speaker: 'server', turns_used: 0, seq: 0, last_message_id: '', deleting: false,
      });
      tx.set(doc(ctx.db, 'rooms', roomId, 'secrets', 'keys'), invites);
      tx.set(doc(ctx.db, 'rooms', roomId, 'members', ctx.uid), { role: 'owner', token: invites.owner, joined_at: serverTimestamp() });
    });
    const session = makeSession(ctx, roomId, 'owner', invites.owner);
    return { roomId, role: 'owner', token: invites.owner, invites, session };
  } catch (error) { throw mapped(error); }
}

export async function joinRoom(ctx, invitation) {
  unbound(ctx);
  const { roomId, token } = invitation || {};
  const role = canonicalRole(invitation?.role);
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(roomId)
      || !ROLES.includes(role) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw fail('invalid_invite', 401, 'The room invitation is invalid');
  }
  try {
    const memberRef = doc(ctx.db, 'rooms', roomId, 'members', ctx.uid);
    await runTransaction(ctx.db, async tx => {
      const previous = await tx.get(memberRef);
      if (previous.exists()) {
        if (previous.data().role !== role || previous.data().token !== token) throw fail('invalid_invite', 401, 'Use a separate context for another role');
      } else tx.set(memberRef, { role, token, joined_at: serverTimestamp() });
    });
    await getDocFromServer(doc(ctx.db, 'rooms', roomId));
    return makeSession(ctx, roomId, role, token);
  } catch (error) {
    const result = mapped(error);
    if (result.code === 'unauthorized') throw fail('invalid_invite', 401, 'The room invitation is invalid or revoked');
    throw result;
  }
}

function makeSession(ctx, roomId, role, token) {
  const roomRef = doc(ctx.db, 'rooms', roomId);
  const messagesRef = collection(roomRef, 'messages');
  const keysRef = doc(roomRef, 'secrets', 'keys');
  function requireOwner() {
    if (role !== 'owner') throw fail('owner_required', 403, 'This operation requires the owner invitation');
  }
  async function readState(after = 0) {
    const snapshot = await getDocFromServer(roomRef);
    if (!snapshot.exists()) throw fail('not_found', 404, 'This room no longer exists');
    const room = snapshot.data();
    const messages = await getDocsFromServer(query(messagesRef, where('seq', '<=', room.seq), orderBy('seq'), limit(100)));
    return stateValue(roomId, role, room, messages.docs.map(item => item.data()), after);
  }
  async function append(body, agent) {
    if (agent ? !['server_agent', 'client_agent'].includes(role) : role !== 'owner') {
      throw fail(agent ? 'agent_required' : 'owner_required', 403, agent ? 'This operation requires an agent invitation' : 'This operation requires the owner invitation');
    }
    if (!object(body)) throw fail('invalid_message', 400, 'Invalid message format');
    const content = text(body.content, 16000);
    const mid = body.client_message_id;
    if (typeof mid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(mid)) {
      throw fail('invalid_message_id', 400, 'Use 1–200 ASCII letters, digits, underscores or hyphens for the message ID');
    }
    const messageRole = agent ? role.replace('_agent', '') : 'human';
    const ref = doc(messagesRef, mid);
    let previous;
    try {
      previous = await runTransaction(ctx.db, async tx => {
        const existing = await tx.get(ref);
        if (existing.exists()) {
          const data = existing.data();
          if (data.role !== messageRole || data.content !== content) throw fail('message_id_conflict', 409, 'This message ID is already used by another role or different content');
          return data;
        }
        const room = (await tx.get(roomRef)).data();
        assertMutable(room);
        if (room.seq >= 100) throw fail('room_full', 409, 'This room has reached its 100-message limit');
        if (agent) {
          if (room.paused || room.turns_used >= room.max_turns) throw fail('room_paused', 409, 'The room is paused; wait for the owner to resume');
          if (room.next_speaker !== messageRole) throw fail('wrong_turn', 409, 'Wait for the other agent to speak');
        }
        const next = { seq: room.seq + 1, last_message_id: mid };
        if (agent) Object.assign(next, { turns_used: room.turns_used + 1, next_speaker: messageRole === 'server' ? 'client' : 'server', paused: room.turns_used + 1 >= room.max_turns });
        tx.set(ref, { seq: next.seq, role: messageRole, content, client_message_id: mid, created_at: serverTimestamp() });
        tx.update(roomRef, next);
        return null;
      });
    } catch (error) {
      // An immutable ID can win a concurrent commit before Firestore reports a
      // transaction conflict. Re-read under the same Rules; never bypass auth.
      if (error.code !== 'permission-denied') throw error;
      const committed = await getDocFromServer(ref);
      if (!committed.exists()) throw error;
      previous = committed.data();
      if (previous.role !== messageRole || previous.content !== content) {
        throw fail('message_id_conflict', 409, 'This message ID is already used by another role or different content');
      }
    }
    return messageValue(previous || (await getDocFromServer(ref)).data());
  }
  async function invitations() {
    const keys = (await getDocFromServer(keysRef)).data();
    return { room_id: roomId, ...Object.fromEntries(ROLES.map(key => [`${key}_token`, keys[key]])) };
  }
  const session = {
    roomId, role, token,
    async request(path, body) {
      try {
        available(ctx);
        const url = new URL(path, 'https://room.invalid');
        const posting = body !== undefined;
        if (url.pathname === '/api/state' && !posting) {
          const values = url.searchParams.getAll('after');
          const raw = values[0] ?? '0';
          if (values.length > 1 || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw fail('invalid_cursor', 400, 'after must be a non-negative safe integer');
          return await readState(Number(raw));
        }
        if (posting && ['/api/agent/messages', '/api/messages'].includes(url.pathname)) return await append(body, url.pathname === '/api/agent/messages');
        if (!['/api/config', '/api/control', '/api/invite'].includes(url.pathname) || (url.pathname === '/api/control' && !posting)) {
          throw fail('not_found', 404, 'Endpoint not found');
        }
        requireOwner();
        if (url.pathname === '/api/config') {
          if (!posting) {
            const data = (await getDocFromServer(roomRef)).data();
            return { topic: data.topic, context: data.context, max_turns: data.max_turns };
          }
          return await runTransaction(ctx.db, async tx => {
            const old = (await tx.get(roomRef)).data(); assertMutable(old);
            const next = configValue(body, { topic: old.topic, context: old.context, max_turns: old.max_turns });
            tx.update(roomRef, { ...next, paused: old.paused || old.turns_used >= next.max_turns });
            return next;
          });
        }
        if (url.pathname === '/api/control') {
          if (!object(body) || !['start', 'pause'].includes(body.action)) throw fail('invalid_action', 400, 'Action must be start or pause');
          await runTransaction(ctx.db, async tx => {
            const old = (await tx.get(roomRef)).data(); assertMutable(old);
            const paused = body.action === 'pause';
            tx.update(roomRef, { paused, turns_used: !paused && old.turns_used >= old.max_turns ? 0 : old.turns_used });
          });
          return await readState();
        }
        if (posting) {
          const target = canonicalRole(body?.role);
          if (!['viewer', 'server_agent', 'client_agent'].includes(target)) throw fail('invalid_invite', 400, 'Only viewer and agent invitations can be rotated');
          await runTransaction(ctx.db, async tx => {
            const old = (await tx.get(roomRef)).data(); assertMutable(old);
            tx.update(keysRef, { [target]: randomKey() });
          });
        }
        return await invitations();
      } catch (error) { throw mapped(error); }
    },
    subscribe(onState, onError = () => {}) {
      available(ctx);
      let room, messages, stopped = false, lastValue, expiryTimer;
      const unsubscribers = [];
      const stop = () => {
        if (stopped) return;
        stopped = true; clearTimeout(expiryTimer);
        for (const off of unsubscribers) off();
        ctx._listeners.delete(stop);
      };
      const failed = error => { stop(); onError(mapped(error)); };
      const emit = () => {
        if (stopped || !room || !messages || (!room.deleting && messages.length !== room.seq)) return;
        const state = stateValue(roomId, role, room, messages);
        const serialized = JSON.stringify(state);
        if (serialized !== lastValue) { lastValue = serialized; onState(state); }
      };
      unsubscribers.push(onSnapshot(roomRef, { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        if (!snapshot.exists()) { failed(fail('not_found', 404, 'This room no longer exists')); return; }
        room = snapshot.data();
        clearTimeout(expiryTimer);
        const remaining = room.created_at.toMillis() + 7 * DAY - Date.now();
        if (remaining > 0) expiryTimer = setTimeout(emit, remaining + 1);
        emit();
      }, failed));
      unsubscribers.push(onSnapshot(query(messagesRef, orderBy('seq'), limit(100)), { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        messages = snapshot.docs.map(item => item.data()); emit();
      }, failed));
      ctx._listeners.add(stop);
      return stop;
    },
    async deleteRoom() {
      try {
        available(ctx); requireOwner();
        for (const off of ctx._listeners) off();
        await runTransaction(ctx.db, async tx => {
          const old = (await tx.get(roomRef)).data();
          if (!old.deleting) tx.update(roomRef, { deleting: true });
        });
        for (const name of ['messages', 'members']) {
          for (;;) {
            const children = await getDocsFromServer(query(collection(roomRef, name), limit(100)));
            const removable = children.docs.filter(child => name !== 'members' || child.id !== ctx.uid);
            if (!removable.length) break;
            const batch = writeBatch(ctx.db);
            for (const child of removable) batch.delete(child.ref);
            await batch.commit();
          }
        }
        const batch = writeBatch(ctx.db);
        batch.delete(doc(roomRef, 'members', ctx.uid)); batch.delete(keysRef); batch.delete(roomRef);
        await batch.commit();
        return { deleted: true, room_id: roomId };
      } catch (error) { throw mapped(error); }
    },
    close: () => ctx.close(),
  };
  ctx._session = session;
  return session;
}
