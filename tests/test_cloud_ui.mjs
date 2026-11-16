import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = new URL('../web/lobby.mjs', import.meta.url);
const origin = 'https://example.test';
const roomId = 'r'.repeat(32), token = 'k'.repeat(43);
const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};

test('accepts only same-site private room invitations with an exact canonical role and fragment key', async () => {
  const { parseInvitation, invitationUrl } = await import(ui);
  const url = invitationUrl(origin, roomId, 'owner', token);
  assert.equal(url, `${origin}/r/${roomId}#role=owner&token=${token}`);
  assert.deepEqual(parseInvitation(url, origin), { roomId, role: 'owner', token });
  assert.deepEqual(parseInvitation(`/r/${roomId}#role=viewer&token=${token}`, origin), { roomId, role: 'viewer', token });
  for (const invalid of [
    `https://evil.test/r/${roomId}#role=owner&token=${token}`,
    `${origin}/r/${roomId}?token=${token}#role=owner&token=${token}`,
    `${origin}/r/${roomId}#role=owner&role=viewer&token=${token}`,
    `${origin}/r/${roomId}#role=server&token=${token}`,
    `${origin}/r/${roomId}#role=owner&token=short`,
    `${origin}/r/${roomId}#role=owner&token=${token}&extra=x`,
    `${origin}/r/tiny#role=owner&token=${token}`,
    'javascript:alert(1)',
  ]) assert.throws(() => parseInvitation(invalid, origin), { code: 'invalid_invite' });
});

test('session capabilities are separated by room and role and can recover after fragment removal', async () => {
  const { saveSession, readSession, clearSession } = await import(ui);
  const storage = memory();
  saveSession(storage, { roomId, role: 'owner', token });
  saveSession(storage, { roomId: 's'.repeat(32), role: 'viewer', token: 'v'.repeat(43) });
  assert.deepEqual(readSession(storage, roomId), { roomId, role: 'owner', token });
  saveSession(storage, { roomId, role: 'viewer', token: 'v'.repeat(43) });
  assert.equal(readSession(storage, roomId).role, 'viewer');
  clearSession(storage, { roomId, role: 'viewer' });
  assert.equal(readSession(storage, roomId), null);
  assert.equal(readSession(storage, 's'.repeat(32)).role, 'viewer');
  assert.equal(readSession(storage, 'x'.repeat(32)), null);
});

test('device recents retain at most twelve metadata records and never store bearer keys', async () => {
  const { rememberRoom, recentRooms, forgetRoom } = await import(ui);
  const storage = memory();
  for (let index = 0; index < 14; index++) rememberRoom(storage, { roomId: `${index}`.padEnd(32, 'r'), topic: `<b>topic ${index}</b>`, role: 'owner', token, updatedAt: index });
  const recent = recentRooms(storage);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].topic, '<b>topic 13</b>');
  assert.ok(recent.every(room => !('token' in room)));
  rememberRoom(storage, { roomId: recent[5].roomId, topic: 'updated', role: 'viewer' });
  assert.equal(recentRooms(storage)[0].topic, 'updated');
  assert.equal(recentRooms(storage).length, 12);
  forgetRoom(storage, recent[5].roomId);
  assert.equal(recentRooms(storage).length, 11);
  const unicodeTopic = '😀'.repeat(200);
  rememberRoom(storage, { roomId, topic: unicodeTopic, role: 'owner' });
  assert.equal(recentRooms(storage)[0].topic, unicodeTopic);
});

test('blocked or corrupted browser storage does not prevent joining from a private link', async () => {
  const { saveSession, readSession, recentRooms, rememberRoom } = await import(ui);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.doesNotThrow(() => saveSession(blocked, { roomId, role: 'owner', token }));
  assert.equal(readSession(blocked, roomId), null);
  assert.deepEqual(recentRooms(blocked), []);
  assert.doesNotThrow(() => rememberRoom(blocked, { roomId, topic: 'Topic', role: 'owner' }));
  const corrupt = { getItem: () => '[{"roomId":"bad","topic":{},"token":"secret"}]' };
  assert.deepEqual(recentRooms(corrupt), []);
});

test('CLI invitation JSON contains only the selected capability and public Firebase config', async () => {
  const { cliInvitation } = await import(ui);
  const firebase = { apiKey: 'public-api-key', projectId: 'public-project', appId: 'public-app' };
  const json = cliInvitation({ origin, roomId, role: 'server_agent', token, firebase });
  assert.deepEqual(json, { protocol: 'agent-debug-room/firebase-v1', url: `${origin}/r/${roomId}`, room_id: roomId, role: 'server_agent', token, firebase });
  assert.throws(() => cliInvitation({ origin, roomId, role: 'owner', token: 'wrong', firebase }), { code: 'invalid_invite' });
});

test('public Firebase configuration is loaded from Hosting and rejects unavailable/invalid responses', async () => {
  const { loadFirebaseConfig } = await import(ui);
  const config = { apiKey: 'public', projectId: 'project', appId: 'app' };
  let requested;
  assert.deepEqual(await loadFirebaseConfig(async path => { requested = path; return { ok: true, json: async () => config }; }), config);
  assert.equal(requested, '/__/firebase/init.json');
  await assert.rejects(loadFirebaseConfig(async () => ({ ok: false })), { code: 'unavailable' });
  await assert.rejects(loadFirebaseConfig(async () => ({ ok: true, json: async () => ({ projectId: 'only' }) })), { code: 'unavailable' });
});

test('all cloud interface catalogs have the same real translations and placeholders', async () => {
  const { LOCALES } = await import('../agent_debug_room/static/i18n.mjs');
  const read = async code => JSON.parse(await readFile(new URL(`../web/locales/${code}.json`, import.meta.url), 'utf8'));
  const english = await read('en');
  const parameters = value => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const { code } of LOCALES) {
    const catalog = await read(code);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), code);
    for (const key of Object.keys(english)) {
      assert.equal(typeof catalog[key], 'string', `${code}: ${key}`);
      assert.ok(catalog[key].trim(), `${code}: ${key}`);
      assert.deepEqual(parameters(catalog[key]), parameters(english[key]), `${code}: ${key}`);
    }
    if (code !== 'en') assert.ok(Object.keys(catalog).filter(key => catalog[key] !== english[key]).length / Object.keys(catalog).length > 0.9, code);
  }
});

test('REST invitations require only HTTP and contain only the selected role capability', async () => {
  const { restInvitation, restInstructions } = await import(ui);
  assert.equal(typeof restInvitation, 'function');
  const invitation = restInvitation({ origin, roomId, role: 'client_agent', token, apiBase: 'https://api.example.test/agent-room/v1' });
  assert.deepEqual(invitation, { protocol: 'agent-debug-room/rest-v1', api_base: 'https://api.example.test/agent-room/v1', room_id: roomId, role: 'client_agent', token, readme: `${origin}/README.md` });
  const text = restInstructions(invitation);
  for (const expected of ['/join', '/state?after=0', '/messages', 'Authorization: Bearer', 'client_message_id', 'paused', 'client', '/README.md']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('agent-debug-room --'));
  assert.ok(!text.includes('npm install'));
});

test('hosted website bundles the plain Markdown guide and connects through REST', async () => {
  const [build, bootstrap, lobby, html, config] = await Promise.all(['scripts/build_web.mjs', 'web/room-bootstrap.mjs', 'web/lobby.mjs', 'web/index.html', 'firebase.json'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));
  assert.ok(build.includes("'web/README.md'"));
  assert.ok(html.includes('href="/README.md"'));
  assert.ok(config.includes('text/markdown'));
  assert.ok(!bootstrap.includes("import('../cloud/store.mjs')"));
  assert.ok(!lobby.includes("import('../cloud/store.mjs')"));
});
