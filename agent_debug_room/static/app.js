import { LOCALES, createI18n, formatTranscript, setInputValidity, validateFormInputs } from './i18n.mjs';

const $ = id => document.getElementById(id);
const transport = globalThis.agentRoomTransport || null;
let unsubscribe = null;
let token = transport ? transport.token : sessionStorage.getItem('dialogue-token') || '';
const fragment = new URLSearchParams(location.hash.slice(1));
if (!transport && (fragment.get('token') || fragment.get('key'))) {
  token = fragment.get('token') || fragment.get('key');
  sessionStorage.setItem('dialogue-token', token);
  history.replaceState(null, '', location.pathname);
}
let localeStorage;
try { localeStorage = localStorage; } catch { /* The interface also works with storage disabled. */ }
const i18n = transport?.i18n || await createI18n({ storage: localeStorage, languages: navigator.languages || [navigator.language], document });
const t = (key, values) => i18n.t(key, values);
let room = null, messages = [], cursor = 0, timer = null, toastTimer = null, connecting = false, generation = 0;
let connectionKey = 'connection.connecting', inviteData = null, activeToast = null;
const visibleErrors = new Map();
function localError(key) { const error = new Error(t(key)); error.key = key; return error; }
function errorText(error) { return error.key ? t(error.key) : error.data || error.code ? i18n.errorMessage(error.data || { code: error.code }, error.status) : error.message || t('error.network'); }
function showError(id, error) {
  if (error) visibleErrors.set(id, error); else visibleErrors.delete(id);
  $(id).textContent = error ? errorText(error) : '';
  if (id === 'room-error') $(id).hidden = !error;
}
async function api(path, body) {
  const version = generation;
  if (transport) {
    const value = await transport.request(path, body);
    if (version !== generation) throw localError('error.session');
    return value;
  }
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch { throw localError('error.network'); }
  let value;
  try { value = await response.json(); } catch { throw localError('error.response'); }
  if (version !== generation) throw localError('error.session');
  if (!response.ok) {
    const error = new Error(i18n.errorMessage(value, response.status));
    error.status = response.status; error.data = value; throw error;
  }
  return value;
}
function toast(value) {
  activeToast = value;
  $('toast').textContent = typeof value === 'string' ? t(value) : errorText(value);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; activeToast = null; }, 4500);
}
async function logout() {
  generation++; connecting = false; clearTimeout(timer); token = ''; room = null; messages = []; cursor = 0;
  if (transport) {
    unsubscribe?.(); unsubscribe = null;
    try { await transport.close(); } finally { transport.leave(); }
    return;
  }
  sessionStorage.removeItem('dialogue-token');
  $('workspace').hidden = true; $('login').hidden = false; $('access-key').value = '';
  $('messages').querySelectorAll('.message').forEach(node => node.remove()); $('empty-state').hidden = false;
  for (const id of ['settings-dialog', 'invite-dialog']) if ($(id).open) $(id).close();
  inviteData = null; visibleErrors.clear();
  for (const id of ['login-error', 'settings-error', 'room-error']) showError(id, null);
  $('agent-instructions').value = ''; $('message-input').value = ''; delete $('message-input').dataset.pendingId; $('settings-form').reset();
  connectionKey = 'connection.connecting';
  applyLanguage();
}
function messageRole(message) { return ['server', 'client', 'human', 'system'].includes(message.role) ? message.role : 'system'; }
function localizeMessage(article, message) {
  article.querySelector('strong').textContent = t(`role.${messageRole(message)}`);
  const time = article.querySelector('time');
  time.textContent = i18n.formatTime(message.created_at);
  time.title = i18n.formatDateTime(message.created_at);
}
function appendMessage(message) {
  if (messages.some(item => item.id === message.id)) return;
  messages.push(message); cursor = Math.max(cursor, Number(message.id)); $('empty-state').hidden = true;
  const role = messageRole(message);
  const article = document.createElement('article'); article.className = `message ${role}`; article.dataset.id = message.id;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = { server: 'A', client: 'B', human: 'H', system: '·' }[role];
  const main = document.createElement('div'); main.className = 'message-main';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong');
  const time = document.createElement('time'); time.dateTime = message.created_at;
  const body = document.createElement('div'); body.className = 'message-body'; body.dir = 'auto'; body.textContent = message.content;
  meta.append(name, time); main.append(meta, body); article.append(avatar, main);
  localizeMessage(article, message); $('messages').append(article);
}
function renderChrome(state) {
  const owner = state.role === 'owner';
  document.querySelectorAll('.owner-only').forEach(node => node.hidden = !owner); $('viewer-note').hidden = owner;
  $('topic-title').textContent = state.topic || t('conversation.title'); $('sidebar-topic').textContent = state.topic || t('conversation.title');
  document.title = `${state.topic || t('conversation.title')} · ${t('app.name')}`;
  $('context-content').textContent = state.context || t('context.empty');
  $('role-note').textContent = t(owner ? 'human.owner' : 'human.viewer');
  const number = new Intl.NumberFormat(i18n.locale);
  $('turn-count').textContent = `${number.format(state.turns_used || 0)} / ${number.format(state.max_turns || 20)}`;
  $('turn-progress').style.width = `${Math.min(100, (state.turns_used || 0) / (state.max_turns || 20) * 100)}%`;
  $('setup-notice').hidden = state.participants?.client?.joined === true || !!state.participants?.client?.last_seen;
  const nextRole = ['server', 'client'].includes(state.next_speaker) ? state.next_speaker : 'agent';
  $('discussion-status').textContent = state.paused ? t('status.paused') : t('status.turn', { name: t(`role.${nextRole}`) });
  $('discussion-status').classList.toggle('active', !state.paused);
  for (const role of ['server', 'client']) {
    const seen = state.participants?.[role]?.joined === true || state.participants?.[role]?.last_seen;
    $(role + '-status').textContent = t(!seen ? 'participant.waiting' : !state.paused && state.next_speaker === role ? 'participant.turn' : 'participant.connected');
  }
  $('start-button').disabled = !state.paused; $('pause-button').disabled = !!state.paused;
  $('control-help').textContent = t(state.paused ? 'control.paused' : 'control.active');
  showError('room-error', state.last_error ? { data: { error: state.last_error, code: state.last_error_code } } : null);
  transport?.updateChrome?.(state, i18n);
}
function render(state) {
  const bottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 140, initial = !room;
  room = state; $('login').hidden = true; $('workspace').hidden = false;
  connectionKey = 'connection.live'; $('connection').classList.remove('offline'); $('connection').lastElementChild.textContent = t(connectionKey);
  renderChrome(state); (state.messages || []).forEach(appendMessage);
  if (initial || bottom) requestAnimationFrame(() => $('messages').scrollTop = $('messages').scrollHeight);
}
async function poll() {
  if (transport || !token || connecting) return;
  const version = generation; connecting = true;
  try { render(await api(`/api/state?after=${cursor}`)); }
  catch (error) {
    if (version !== generation) return;
    if (error.status === 401) { logout(); showError('login-error', { data: { code: 'unauthorized' } }); }
    else {
      connectionKey = 'connection.reconnecting'; $('connection').classList.add('offline'); $('connection').lastElementChild.textContent = t(connectionKey);
      if (!room) showError('login-error', error);
    }
  }
  finally { if (version === generation) { connecting = false; clearTimeout(timer); if (token) timer = setTimeout(poll, document.hidden ? 3000 : 1000); } }
}
async function openSettings() {
  try {
    const config = await api('/api/config');
    $('topic-input').value = config.topic || ''; $('context-input').value = config.context || ''; $('max-turns').value = config.max_turns || 20;
    for (const id of ['topic-input', 'context-input', 'max-turns']) setInputValidity($(id), i18n);
    showError('settings-error', null); $('settings-dialog').showModal();
  } catch (error) { toast(error); }
}
function renderInvite() {
  if (!inviteData) return;
  if (transport) { transport.renderInvite(inviteData, i18n); return; }
  const base = location.origin, key = inviteData.client_agent_token;
  const read = `curl -sS -H 'Authorization: Bearer ${key}' '${base}/api/state?after=0'`;
  const reply = JSON.stringify({ content: t('invite.content'), client_message_id: t('invite.messageId') });
  const send = `curl --fail-with-body -sS -H 'Authorization: Bearer ${key}' -H 'Content-Type: application/json' --data-binary @reply.json '${base}/api/agent/messages'`;
  $('agent-instructions').value = [t('invite.opening'), t('invite.tools'), t('invite.connection', { base, key }), `${t('invite.read')}\n${read}`, `${t('invite.reply')}\n${reply}\n${t('invite.send')}\n${send}`, t('invite.poll'), t('invite.scope')].join('\n\n');
}
async function openInvite() {
  try { inviteData = await api('/api/invite'); renderInvite(); $('invite-dialog').showModal(); }
  catch (error) { toast(error); }
}
function applyLanguage() {
  i18n.translateDocument(document);
  for (const id of ['access-key', 'topic-input', 'context-input', 'message-input', 'max-turns']) if ($(id).validity.customError) setInputValidity($(id), i18n);
  for (const id of ['login-language', 'room-language']) $(id).value = i18n.locale;
  $('connection').lastElementChild.textContent = t(connectionKey);
  if (room) renderChrome(room); else document.title = t('app.title');
  $('messages').querySelectorAll('.message').forEach(article => {
    const message = messages.find(item => String(item.id) === article.dataset.id);
    if (message) localizeMessage(article, message);
  });
  for (const [id, error] of visibleErrors) $(id).textContent = errorText(error);
  if (activeToast) $('toast').textContent = typeof activeToast === 'string' ? t(activeToast) : errorText(activeToast);
  renderInvite();
}
for (const id of ['login-language', 'room-language']) {
  for (const { code, name } of LOCALES) {
    const option = document.createElement('option'); option.value = code; option.lang = code; option.textContent = name; $(id).append(option);
  }
  $(id).addEventListener('change', event => i18n.setLocale(event.target.value));
}
for (const id of ['access-key', 'topic-input', 'context-input', 'message-input', 'max-turns']) {
  $(id).addEventListener('invalid', event => setInputValidity(event.target, i18n));
  $(id).addEventListener('input', event => setInputValidity(event.target, i18n));
}
i18n.onChange(applyLanguage);
applyLanguage();

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!validateFormInputs(event.currentTarget, i18n)) return;
  generation++; connecting = false; clearTimeout(timer);
  token = $('access-key').value.trim(); sessionStorage.setItem('dialogue-token', token); showError('login-error', null); await poll();
});
$('logout-button').addEventListener('click', logout);
$('settings-button').addEventListener('click', openSettings);
$('invite-button').addEventListener('click', openInvite);
$('setup-button').addEventListener('click', openInvite);
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('close-invite').addEventListener('click', () => $('invite-dialog').close());
$('invite-dialog').addEventListener('close', () => { inviteData = null; $('agent-instructions').value = ''; });
$('copy-invite').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('agent-instructions').value); toast('toast.inviteCopied'); }
  catch { $('agent-instructions').focus(); $('agent-instructions').select(); toast('toast.selectCopy'); }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!validateFormInputs(event.currentTarget, i18n)) return;
  $('save-settings').disabled = true;
  try {
    await api('/api/config', { topic: $('topic-input').value.trim(), context: $('context-input').value.trim(), max_turns: Number($('max-turns').value) });
    $('settings-dialog').close(); await poll(); toast('toast.saved');
  } catch (error) { showError('settings-error', error); }
  finally { $('save-settings').disabled = false; }
});
for (const [id, action] of [['start-button', 'start'], ['pause-button', 'pause']]) {
  $(id).addEventListener('click', async () => { try { await api('/api/control', { action }); await poll(); } catch (error) { toast(error); } });
}
$('message-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!validateFormInputs(event.currentTarget, i18n)) return;
  const content = $('message-input').value.trim(); if (!content) return;
  $('send-button').disabled = true;
  const id = $('message-input').dataset.pendingId || crypto.randomUUID(); $('message-input').dataset.pendingId = id;
  try {
    await api('/api/messages', { content, client_message_id: id });
    $('message-input').value = ''; delete $('message-input').dataset.pendingId; await poll();
  } catch (error) { toast(error); }
  finally { $('send-button').disabled = false; }
});
$('message-input').addEventListener('input', () => delete $('message-input').dataset.pendingId);
$('message-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('share-button').addEventListener('click', async () => {
  try {
    const invite = await api('/api/invite'), url = transport ? transport.viewerUrl(invite) : `${location.origin}/#token=${encodeURIComponent(invite.viewer_token)}`;
    try { await navigator.clipboard.writeText(url); toast('toast.viewerCopied'); }
    catch { window.prompt(t('share.prompt'), url); }
  } catch (error) { toast(error); }
});
$('export-button').addEventListener('click', () => {
  if (!messages.length) return toast('export.empty');
  const text = formatTranscript(room, messages, i18n);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = 'agent-debug-room-transcript.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { clearTimeout(timer); poll(); } });
if (transport) {
  transport.toast = toast;
  $('login').hidden = true;
  const version = generation;
  unsubscribe = transport.subscribe(state => {
    if (version === generation) render(state);
  }, error => {
    if (version !== generation) return;
    connectionKey = 'connection.reconnecting'; $('connection').classList.add('offline'); $('connection').lastElementChild.textContent = t(connectionKey);
    showError('room-error', error);
  });
} else if (token) poll();
