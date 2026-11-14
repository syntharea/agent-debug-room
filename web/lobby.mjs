import { LOCALES, createI18n, setInputValidity, validateFormInputs } from '../agent_debug_room/static/i18n.mjs';

const ROLES = ['owner', 'viewer', 'server_agent', 'client_agent'];
const ROOM_ID = /^[A-Za-z0-9_-]{20,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const RECENTS_KEY = 'agent-debug-room-recent-v1';
const sessionKey = (roomId, role) => `agent-debug-room:${roomId}:${role}`;
const activeRoleKey = roomId => `agent-debug-room:${roomId}:active-role`;
function uiError(code) { const error = new Error(code); error.code = code; error.data = { code }; return error; }
function validCapability({ roomId, role, token }) { return ROOM_ID.test(roomId) && ROLES.includes(role) && KEY.test(token); }

export function invitationUrl(origin, roomId, role, token) {
  if (!validCapability({ roomId, role, token })) throw uiError('invalid_invite');
  return `${new URL(origin).origin}/r/${roomId}#role=${role}&token=${token}`;
}
export function parseInvitation(value, origin) {
  let url;
  try { url = new URL(value.trim(), origin); } catch { throw uiError('invalid_invite'); }
  const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{20,64})$/);
  const parameters = new URLSearchParams(url.hash.slice(1));
  const entries = [...parameters.entries()];
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || !match || entries.length !== 2 || parameters.getAll('role').length !== 1 || parameters.getAll('token').length !== 1) throw uiError('invalid_invite');
  const invitation = { roomId: match[1], role: parameters.get('role'), token: parameters.get('token') };
  if (!validCapability(invitation)) throw uiError('invalid_invite');
  return invitation;
}
export function saveSession(storage, invitation) {
  if (!validCapability(invitation)) throw uiError('invalid_invite');
  try {
    storage?.setItem(sessionKey(invitation.roomId, invitation.role), invitation.token);
    storage?.setItem(activeRoleKey(invitation.roomId), invitation.role);
  } catch { /* A fresh invitation still works when browser storage is blocked. */ }
}
export function readSession(storage, roomId) {
  try {
    const role = storage?.getItem(activeRoleKey(roomId));
    const invitation = { roomId, role, token: storage?.getItem(sessionKey(roomId, role)) };
    return validCapability(invitation) ? invitation : null;
  } catch { return null; }
}
export function clearSession(storage, { roomId, role }) {
  try {
    storage?.removeItem(sessionKey(roomId, role));
    if (storage?.getItem(activeRoleKey(roomId)) === role) storage.removeItem(activeRoleKey(roomId));
  } catch { /* Storage may be unavailable. */ }
}
export function recentRooms(storage) {
  try {
    const value = JSON.parse(storage?.getItem(RECENTS_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(room => room && ROOM_ID.test(room.roomId) && typeof room.topic === 'string' && ROLES.includes(room.role)).slice(0, 12).map(room => ({ roomId: room.roomId, topic: Array.from(room.topic).slice(0, 200).join(''), role: room.role, updatedAt: Number.isFinite(room.updatedAt) ? room.updatedAt : 0 }));
  } catch { return []; }
}
export function rememberRoom(storage, room) {
  if (!ROOM_ID.test(room.roomId) || typeof room.topic !== 'string' || !ROLES.includes(room.role)) return;
  const metadata = { roomId: room.roomId, topic: Array.from(room.topic).slice(0, 200).join(''), role: room.role, updatedAt: Date.now() };
  try { storage?.setItem(RECENTS_KEY, JSON.stringify([metadata, ...recentRooms(storage).filter(item => item.roomId !== room.roomId)].slice(0, 12))); } catch { /* Recents are optional device metadata. */ }
}
export function forgetRoom(storage, roomId) {
  try { storage?.setItem(RECENTS_KEY, JSON.stringify(recentRooms(storage).filter(item => item.roomId !== roomId))); } catch { /* Recents are optional device metadata. */ }
}
export function cliInvitation({ origin, roomId, role, token, firebase, emulators }) {
  invitationUrl(origin, roomId, role, token);
  return { protocol: 'agent-debug-room/firebase-v1', url: `${new URL(origin).origin}/r/${roomId}`, room_id: roomId, role, token, firebase, ...(emulators ? { emulators } : {}) };
}
export async function loadFirebaseConfig(fetcher = fetch) {
  try {
    const response = await fetcher('/__/firebase/init.json', { cache: 'no-store' });
    if (!response.ok) throw uiError('unavailable');
    const config = await response.json();
    if (!config || !['apiKey', 'projectId', 'appId'].every(key => typeof config[key] === 'string' && config[key])) throw uiError('unavailable');
    return config;
  } catch { throw uiError('unavailable'); }
}
export function browserStorage(name) { try { return globalThis[name]; } catch { return undefined; } }
export function describeError(error, i18n) {
  return i18n.errorMessage(error.data || { code: error.code, error: error.code ? undefined : error.message }, error.status);
}
export async function initializeLanguage(select, render) {
  const i18n = await createI18n({ storage: browserStorage('localStorage'), languages: navigator.languages || [navigator.language], document });
  for (const { code, name } of LOCALES) {
    const option = document.createElement('option'); option.value = code; option.lang = code; option.textContent = name; select.append(option);
  }
  const update = () => { i18n.translateDocument(document); select.value = i18n.locale; render(i18n); };
  select.addEventListener('change', event => i18n.setLocale(event.target.value));
  i18n.onChange(update); update();
  return i18n;
}

async function startLobby() {
  const $ = id => document.getElementById(id), storage = browserStorage('localStorage'), sessions = browserStorage('sessionStorage');
  let i18n, busy = false, activeError = null;
  function render(language) {
    i18n = language; document.title = i18n.t('cloud.home.title');
    for (const id of ['create-topic', 'create-context', 'invitation-input']) if ($(id).validity.customError) setInputValidity($(id), i18n);
    $('create-room').textContent = i18n.t(busy ? 'cloud.creating' : 'cloud.create.action');
    $('lobby-error').textContent = activeError ? describeError(activeError, i18n) : '';
    $('recent-list').replaceChildren();
    const rooms = recentRooms(storage); $('recent-empty').hidden = !!rooms.length;
    for (const room of rooms) {
      const item = document.createElement('li'); item.className = 'recent-room';
      const details = document.createElement('div'), title = document.createElement('strong'), role = document.createElement('span');
      title.textContent = room.topic; role.textContent = i18n.t(`cloud.role.${room.role}`); details.append(title, role);
      const actions = document.createElement('div'); actions.className = 'recent-actions';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'button secondary';
      const session = readSession(sessions, room.roomId);
      open.textContent = i18n.t(session ? 'cloud.recent.open' : 'cloud.recent.needsLink'); open.disabled = !session;
      open.addEventListener('click', () => location.assign(invitationUrl(location.origin, session.roomId, session.role, session.token)));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button quiet'; remove.textContent = i18n.t('cloud.recent.remove');
      remove.addEventListener('click', () => { forgetRoom(storage, room.roomId); render(i18n); });
      actions.append(open, remove); item.append(details, actions); $('recent-list').append(item);
    }
  }
  await initializeLanguage($('lobby-language'), render);
  for (const id of ['create-topic', 'create-context', 'invitation-input']) {
    $(id).addEventListener('invalid', event => setInputValidity(event.target, i18n));
    $(id).addEventListener('input', event => setInputValidity(event.target, i18n));
  }
  $('create-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !validateFormInputs(event.currentTarget, i18n)) return;
    busy = true; activeError = null; $('create-room').disabled = true; render(i18n);
    let context;
    try {
      const firebase = globalThis.agentRoomFirebaseConfig || await loadFirebaseConfig();
      const { openContext, createRoom } = await import('../cloud/store.mjs');
      context = await openContext(firebase, globalThis.agentRoomFirebaseOptions || {});
      const created = await createRoom(context, { topic: $('create-topic').value.trim(), context: $('create-context').value.trim(), max_turns: 20 });
      const invitation = { roomId: created.roomId, role: 'owner', token: created.token };
      saveSession(sessions, invitation); rememberRoom(storage, { ...invitation, topic: $('create-topic').value.trim() });
      try { await created.session.close(); } catch { /* Creation succeeded; do not create a duplicate room. */ }
      location.assign(invitationUrl(location.origin, created.roomId, 'owner', created.token));
    } catch (error) {
      if (context) try { await context.close(); } catch { /* Preserve the original failure. */ }
      activeError = error; busy = false; $('create-room').disabled = false; render(i18n); $('lobby-error').focus();
    }
  });
  $('open-form').addEventListener('submit', event => {
    event.preventDefault(); if (!validateFormInputs(event.currentTarget, i18n)) return;
    try { const invitation = parseInvitation($('invitation-input').value, location.origin); location.assign(invitationUrl(location.origin, invitation.roomId, invitation.role, invitation.token)); }
    catch (error) { activeError = error; render(i18n); $('lobby-error').focus(); }
  });
}
if (typeof document !== 'undefined' && document.getElementById('lobby')) startLobby().catch(() => {
  const message = document.getElementById('lobby-error'); message.textContent = 'Unable to load the interface. Reload to try again.';
});
