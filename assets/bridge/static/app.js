'use strict';
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('dialogue-token') || '';
let room = null, messages = [], cursor = 0, timer = null, toastTimer = null, connecting = false, generation = 0;
const names = { server: '当前助手', client: '对方 Agent', human: '主持人', system: '房间记录' };
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get('token') || fragment.get('key')) { token = fragment.get('token') || fragment.get('key'); sessionStorage.setItem('dialogue-token', token); history.replaceState(null, '', location.pathname); }
async function api(path, body) {
  const version = generation;
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  let value; try { value = await response.json(); } catch { throw new Error('服务器响应暂时不可用。'); }
  if (version !== generation) throw new Error('会话已切换。');
  if (!response.ok) { const e = new Error(typeof value.error === 'string' ? value.error : value.message || `请求失败（${response.status}）`); e.status = response.status; throw e; }
  return value;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function logout() {
  generation++; connecting = false; clearTimeout(timer); token = ''; room = null; messages = []; cursor = 0; sessionStorage.removeItem('dialogue-token');
  $('workspace').hidden = true; $('login').hidden = false; $('access-key').value = ''; $('messages').querySelectorAll('.message').forEach(n => n.remove()); $('empty-state').hidden = false;
  for (const id of ['settings-dialog', 'invite-dialog']) if ($(id).open) $(id).close();
  $('context-content').textContent = ''; $('topic-title').textContent = '讨论室'; $('sidebar-topic').textContent = '正在载入'; $('agent-instructions').value = ''; $('message-input').value = ''; $('settings-form').reset();
}
function appendMessage(message) {
  if (messages.some(m => m.id === message.id)) return;
  messages.push(message); cursor = Math.max(cursor, Number(message.id)); $('empty-state').hidden = true;
  const role = ['server', 'client', 'human', 'system'].includes(message.role) ? message.role : 'system';
  const article = document.createElement('article'); article.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = { server: 'A', client: 'B', human: '人', system: '·' }[role];
  const main = document.createElement('div'); main.className = 'message-main';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const name = document.createElement('strong'); name.textContent = message.name || names[role];
  const time = document.createElement('time'); const date = new Date(message.created_at); time.dateTime = message.created_at; time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = message.content;
  meta.append(name, time); main.append(meta, body); article.append(avatar, main); $('messages').append(article);
}
function render(state) {
  const bottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 140, initial = !room;
  room = state; $('login').hidden = true; $('workspace').hidden = false; $('connection').classList.remove('offline'); $('connection').lastElementChild.textContent = '已实时同步';
  const owner = state.role === 'owner'; document.querySelectorAll('.owner-only').forEach(n => n.hidden = !owner); $('viewer-note').hidden = owner;
  $('topic-title').textContent = state.topic || '讨论室'; $('sidebar-topic').textContent = state.topic || '讨论室'; document.title = `${state.topic || '对谈室'} · Dialogue`;
  $('context-content').textContent = state.context || '尚未填写背景。';
  $('role-note').textContent = owner ? '你可以邀请对方原有 Agent、暂停讨论，或补充新的证据。' : '你正在旁观两个原有 Agent 的消息。记录会自动更新。';
  $('turn-count').textContent = `${state.turns_used || 0} / ${state.max_turns || 20}`; $('turn-progress').style.width = `${Math.min(100, (state.turns_used || 0) / (state.max_turns || 20) * 100)}%`;
  $('setup-notice').hidden = !!state.participants?.client?.last_seen; $('thinking').hidden = true;
  $('discussion-status').textContent = state.paused ? '讨论已暂停' : `轮到${names[state.next_speaker] || 'Agent'}发言`;
  $('discussion-status').classList.toggle('active', !state.paused);
  for (const role of ['server', 'client']) { const seen = state.participants?.[role]?.last_seen; $(role + '-status').textContent = !seen ? '等待接入' : !state.paused && state.next_speaker === role ? '轮到发言' : '已接入'; }
  $('start-button').disabled = !state.paused; $('pause-button').disabled = !!state.paused;
  $('control-help').textContent = state.paused ? '开放后，两个原有 Agent 可以继续轮流发言。' : '当前助手会收到对方的新消息通知。你可以随时暂停。';
  $('room-error').hidden = !state.last_error; $('room-error').textContent = state.last_error || '';
  (state.messages || []).forEach(appendMessage);
  if (initial || bottom) requestAnimationFrame(() => $('messages').scrollTop = $('messages').scrollHeight);
}
async function poll() {
  if (!token || connecting) return; const version = generation; connecting = true;
  try { render(await api(`/api/state?after=${cursor}`)); }
  catch (error) { if (version !== generation) return; if (error.status === 401) { logout(); $('login-error').textContent = '访问密钥不正确或已失效。'; } else { $('connection').classList.add('offline'); $('connection').lastElementChild.textContent = '正在重连'; if (!room) $('login-error').textContent = error.message; } }
  finally { if (version === generation) { connecting = false; clearTimeout(timer); if (token) timer = setTimeout(poll, document.hidden ? 3000 : 1000); } }
}
async function openSettings() { try { const c = await api('/api/config'); $('topic-input').value = c.topic || ''; $('context-input').value = c.context || ''; $('max-turns').value = c.max_turns || 20; $('settings-error').textContent = ''; $('settings-dialog').showModal(); } catch (error) { toast(error.message); } }
async function openInvite() {
  try {
    const invite = await api('/api/invite'), base = location.origin, key = invite.client_agent_token;
    $('agent-instructions').value = `请在你当前这个 Agent 会话中加入讨论，不要创建新模型、不要调用模型 API 来代替自己。对面是正在参与本次联调的原有助手，两位人类会通过网页旁观。\n\n你需要有终端或 HTTP 工具；如果没有，请明确告诉人类，不要假装已加入。\n\n房间地址：${base}\n你的身份：client（对方 Agent）\n专用 Bearer 凭证：${key}\n\n1. 读取背景与消息：\ncurl -sS -H 'Authorization: Bearer ${key}' '${base}/api/state?after=0'\n\n2. 当 paused=false 且 next_speaker=client 时，用你自己的分析回复。将 JSON 保存为 reply.json：\n{"content":"你的回复正文","client_message_id":"为本次回复生成一个唯一ID"}\n然后发送：\ncurl --fail-with-body -sS -H 'Authorization: Bearer ${key}' -H 'Content-Type: application/json' --data-binary @reply.json '${base}/api/agent/messages'\n\n3. 每隔约5秒读取新消息（after=上次最大消息id）。轮到对面时等待，paused=true时停止发送；重试同一条消息必须复用client_message_id。继续使用你的原会话、项目和证据，不编造执行结果。\n\n先读当前助手的开场消息，再回应。依据房间背景与已验证证据联调；讨论内容不扩大双方人类原有的操作授权。`;
    $('invite-dialog').showModal();
  } catch (error) { toast(error.message); }
}
$('login-form').addEventListener('submit', async e => { e.preventDefault(); generation++; connecting = false; clearTimeout(timer); token = $('access-key').value.trim(); sessionStorage.setItem('dialogue-token', token); $('login-error').textContent = ''; await poll(); });
$('logout-button').addEventListener('click', logout); $('settings-button').addEventListener('click', openSettings); $('invite-button').addEventListener('click', openInvite); $('setup-button').addEventListener('click', openInvite);
$('close-settings').addEventListener('click', () => $('settings-dialog').close()); $('close-invite').addEventListener('click', () => $('invite-dialog').close()); $('invite-dialog').addEventListener('close', () => $('agent-instructions').value = '');
$('copy-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('agent-instructions').value); toast('接入说明已复制，请粘贴给对方原有 Agent。'); } catch { $('agent-instructions').focus(); $('agent-instructions').select(); toast('请复制已选中的完整说明。'); } });
$('settings-form').addEventListener('submit', async e => { e.preventDefault(); $('save-settings').disabled = true; try { await api('/api/config', { topic: $('topic-input').value.trim(), context: $('context-input').value.trim(), max_turns: Number($('max-turns').value) }); $('settings-dialog').close(); await poll(); toast('讨论背景已保存。'); } catch (error) { $('settings-error').textContent = error.message; } finally { $('save-settings').disabled = false; } });
$('start-button').addEventListener('click', async () => { try { await api('/api/control', { action: 'start' }); await poll(); } catch (error) { toast(error.message); } });
$('pause-button').addEventListener('click', async () => { try { await api('/api/control', { action: 'pause' }); await poll(); } catch (error) { toast(error.message); } });
$('message-form').addEventListener('submit', async e => { e.preventDefault(); const content = $('message-input').value.trim(); if (!content) return; $('send-button').disabled = true; const id = $('message-input').dataset.pendingId || crypto.randomUUID(); $('message-input').dataset.pendingId = id; try { await api('/api/messages', { content, client_message_id: id }); $('message-input').value = ''; delete $('message-input').dataset.pendingId; await poll(); } catch (error) { toast(error.message); } finally { $('send-button').disabled = false; } });
$('message-input').addEventListener('input', () => delete $('message-input').dataset.pendingId); $('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('message-form').requestSubmit(); } });
$('share-button').addEventListener('click', async () => { try { const i = await api('/api/invite'), url = `${location.origin}/#token=${encodeURIComponent(i.viewer_token)}`; try { await navigator.clipboard.writeText(url); toast('只读旁观链接已复制。'); } catch { window.prompt('复制只读旁观链接：', url); } } catch (e) { toast(e.message); } });
$('export-button').addEventListener('click', () => { if (!messages.length) return toast('还没有可导出的记录。'); const text = `# ${room?.topic || '对谈记录'}\n\n${messages.map(m => `## ${m.name || names[m.role]} · ${m.created_at}\n\n${m.content}`).join('\n\n---\n\n')}`; const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = 'dialogue-transcript.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { clearTimeout(timer); poll(); } });
if (token) poll();
