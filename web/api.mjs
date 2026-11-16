export const DEFAULT_API_BASE = 'https://api.letsllm.com/agent-room/v1';
export function apiBase() { return (globalThis.agentRoomApiBase || DEFAULT_API_BASE).replace(/\/$/, ''); }
export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  let response;
  try {
    response = await fetch(apiBase() + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(30000) });
  } catch { throw Object.assign(new Error('Service unavailable'), { code: 'unavailable', status: 503 }); }
  let data;
  try { data = await response.json(); } catch { throw Object.assign(new Error('Service unavailable'), { code: 'unavailable', status: 503 }); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code, data, status: response.status });
  return data;
}
export async function createRestRoom(configuration) { return apiRequest('/rooms', { method: 'POST', body: configuration }); }
export async function joinRestRoom(invitation) {
  let closed = false, token, renewing;
  const path = `/rooms/${invitation.roomId}`;
  async function join() {
    const result = await apiRequest(path + '/join', { method: 'POST', body: { role: invitation.role, token: invitation.token } });
    token = result.session_token;
  }
  await join();
  async function request(relative, body) {
    if (closed) throw Object.assign(new Error('Session closed'), { code: 'unauthorized', status: 401 });
    const url = new URL(relative, 'https://room.invalid');
    const endpoints = { '/api/state': 'state', '/api/messages': 'messages', '/api/agent/messages': 'messages', '/api/config': 'config', '/api/control': 'control', '/api/invite': 'invitations' };
    if (!endpoints[url.pathname]) throw Object.assign(new Error('Endpoint not found'), { code: 'not_found', status: 404 });
    const perform = () => apiRequest(`${path}/${endpoints[url.pathname]}${url.search}`, { ...(body === undefined ? {} : { method: 'POST', body }), token });
    try { return await perform(); }
    catch (error) {
      if (error.code !== 'session_expired') throw error;
      // Only expired sessions are replayed, never a response that could have
      // committed a non-idempotent write. An expired session did no room work.
      renewing ||= join().finally(() => { renewing = null; });
      await renewing;
      return perform();
    }
  }
  return {
    request,
    async deleteRoom() { return apiRequest(path, { method: 'DELETE', token }); },
    async close() { if (closed) return; closed = true; await apiRequest('/session', { method: 'DELETE', token }).catch(() => {}); },
    subscribe(onState, onError) {
      let stopped = false, timer;
      async function poll() {
        try {
          const state = await request('/api/state');
          if (stopped) return;
          onState(state);
          timer = setTimeout(poll, state.paused ? 10000 : 5000);
        } catch (error) {
          if (stopped) return;
          onError(error);
          if (![401, 403, 404].includes(error.status)) timer = setTimeout(poll, 15000);
        }
      }
      poll();
      return () => { stopped = true; clearTimeout(timer); };
    },
  };
}
