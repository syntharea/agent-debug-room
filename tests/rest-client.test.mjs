import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinRestRoom } from '../web/api.mjs';

// Mocking only the network makes transport retries deterministic; permissions
// and persistence are tested separately against the real Firebase emulator.
test('browser transport rejoins an expired session and never retries an uncertain mutation', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let expired = true, joins = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/join')) return { ok: true, json: async () => ({ session_token: `session-${++joins}` }) };
    if (expired) { expired = false; return { ok: false, status: 401, json: async () => ({ code: 'session_expired', error: 'Expired' }) }; }
    if (url.endsWith('/control')) throw new Error('Response lost');
    return { ok: true, json: async () => ({ room_id: 'r'.repeat(32), paused: true, messages: [] }) };
  };
  try {
    const session = await joinRestRoom({ roomId: 'r'.repeat(32), role: 'owner', token: 'invite' });
    await session.request('/api/state');
    assert.equal(joins, 2);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer session-2');
    await assert.rejects(session.request('/api/control', { action: 'start' }), { code: 'unavailable' });
    assert.equal(calls.filter(call => call.url.endsWith('/control')).length, 1);
    await session.close();
  } finally { globalThis.fetch = original; }
});
