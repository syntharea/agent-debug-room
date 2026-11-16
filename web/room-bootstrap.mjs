import { apiBase, joinRestRoom } from './api.mjs';
import { browserStorage, clearSession, restInvitation, restInstructions, describeError, forgetRoom, initializeLanguage, invitationUrl, parseInvitation, readSession, rememberRoom, saveSession } from './lobby.mjs';

const $ = id => document.getElementById(id);
function node(tag, { id, className, key, type, dir } = {}) {
  const value = document.createElement(tag);
  if (id) value.id = id;
  if (className) value.className = className;
  if (key) value.dataset.i18n = key;
  if (type) value.type = type;
  if (dir) value.dir = dir;
  return value;
}
async function startRoom() {
  $('login').hidden = true;
  const gate = node('section', { className: 'cloud-gate' });
  const heading = node('h1', { key: 'cloud.join.title' });
  const status = node('p', { className: 'cloud-loading-status', key: 'cloud.join.loading' }); status.setAttribute('role', 'status');
  const home = node('a', { className: 'button secondary', key: 'cloud.home.back' }); home.href = '/';
  const control = node('div', { className: 'language-control' }), label = node('label', { className: 'sr-only', key: 'language.label' }); label.htmlFor = 'gate-language';
  const select = node('select', { id: 'gate-language', className: 'language-select', dir: 'ltr' }); control.append(label, select);
  gate.append(heading, status, home, control); document.body.prepend(gate);
  let language, gateError = null;
  await initializeLanguage(select, i18n => {
    language = i18n;
    if (gateError) status.textContent = describeError(gateError, language);
  });
  const t = (key, values) => language.t(key, values);
  function showGate(error) {
    gateError = error; gate.hidden = false; $('workspace').hidden = true; $('login').hidden = true;
    heading.textContent = t('cloud.join.unavailable'); status.textContent = describeError(error, language);
    select.value = language.locale;
  }
  const sessions = browserStorage('sessionStorage'), recents = browserStorage('localStorage');
  let session;
  try {
    const match = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{20,64})$/);
    if (!match) throw Object.assign(new Error('Invalid invitation'), { code: 'invalid_invite' });
    const invitation = location.hash ? parseInvitation(location.href, location.origin) : readSession(sessions, match[1]);
    if (!invitation) throw Object.assign(new Error('Invitation required'), { code: 'invalid_invite' });
    saveSession(sessions, invitation);
    history.replaceState(null, '', location.pathname);
    session = await joinRestRoom(invitation);
    const roomUrl = role => invitationUrl(location.origin, invitation.roomId, role, role === invitation.role ? invitation.token : '');
    let currentState = null, activeInvites = null, selectedRole = 'server_agent', deletingRoom = false, deletionInterrupted = false, closed = false;

    const summary = node('p', { className: 'cloud-room-summary' });
    const readonly = node('div', { className: 'cloud-room-notice cloud-room-readonly' }); readonly.hidden = true;
    const recovery = node('div', { className: 'cloud-room-notice owner-only' }); recovery.hidden = true;
    const recoveryText = node('div'), recoveryTitle = node('strong', { key: 'cloud.recovery.title' }), recoveryHelp = node('p', { key: 'cloud.recovery.help' });
    recoveryText.append(recoveryTitle, recoveryHelp);
    const recoveryCopy = node('button', { className: 'button secondary', type: 'button', key: 'cloud.recovery.copy' });
    recovery.append(recoveryText, recoveryCopy);
    const conversation = document.querySelector('.conversation'); conversation.prepend(recovery, summary, readonly);
    const deleteButton = node('button', { className: 'button quiet cloud-danger-button owner-only', type: 'button', key: 'cloud.delete.action' }); deleteButton.hidden = true;
    document.querySelector('.topbar-actions').insertBefore(deleteButton, $('logout-button'));

    const inviteControls = node('div', { className: 'cloud-invite-controls' }), roleField = node('div');
    const roleLabel = node('label', { key: 'cloud.invite.role' }); roleLabel.htmlFor = 'cloud-invite-role';
    const roleSelect = node('select', { id: 'cloud-invite-role' });
    for (const role of ['server_agent', 'client_agent', 'viewer']) {
      const option = node('option', { key: `cloud.role.${role}` }); option.value = role; roleSelect.append(option);
    }
    roleField.append(roleLabel, roleSelect);
    const rotate = node('button', { className: 'button secondary cloud-danger-button', type: 'button', key: 'cloud.invite.rotate' });
    inviteControls.append(roleField, rotate);
    const linkField = node('div', { className: 'cloud-invite-field' }), linkLabel = node('label', { key: 'cloud.invite.link' }); linkLabel.htmlFor = 'cloud-invite-link';
    const linkInput = node('input', { id: 'cloud-invite-link', type: 'text', dir: 'ltr' }); linkInput.readOnly = true;
    const linkActions = node('div', { className: 'cloud-invite-actions' }), linkCopy = node('button', { className: 'button secondary', type: 'button', key: 'cloud.invite.copyLink' }); linkActions.append(linkCopy);
    linkField.append(linkLabel, linkInput, linkActions);
    const jsonField = node('div', { className: 'cloud-invite-field' }), jsonLabel = node('label', { key: 'cloud.invite.json' }); jsonLabel.htmlFor = 'cloud-invite-json';
    const jsonInput = node('textarea', { id: 'cloud-invite-json', dir: 'ltr' }); jsonInput.readOnly = true; jsonInput.rows = 7; jsonInput.spellcheck = false;
    const jsonActions = node('div', { className: 'cloud-invite-actions' }), jsonCopy = node('button', { className: 'button secondary', type: 'button', key: 'cloud.invite.copyJson' }); jsonActions.append(jsonCopy);
    jsonField.append(jsonLabel, jsonInput, jsonActions);
    const guide = node('a', { key: 'cloud.readme' }); guide.href = '/README.md'; guide.target = '_blank'; guide.rel = 'noopener';
    jsonField.append(guide);
    const instructionLabel = document.querySelector('label[for="agent-instructions"]'); instructionLabel.classList.remove('sr-only'); instructionLabel.classList.add('cloud-instructions-label');
    instructionLabel.before(inviteControls, linkField, jsonField);

    const confirmation = node('dialog', { className: 'settings-dialog cloud-confirm' }); confirmation.setAttribute('aria-labelledby', 'cloud-confirm-title');
    const confirmTitle = node('h2', { id: 'cloud-confirm-title' }), confirmText = node('p'), confirmFooter = node('div', { className: 'dialog-footer' });
    const cancel = node('button', { className: 'button secondary', type: 'button', key: 'cloud.confirm.cancel' });
    const accept = node('button', { className: 'button primary cloud-danger-button', type: 'button', key: 'cloud.confirm.continue' });
    confirmFooter.append(cancel, accept); confirmation.append(confirmTitle, confirmText, confirmFooter); document.body.append(confirmation);
    let pendingConfirm = null;
    function confirmAction(titleKey, textKey, values) {
      confirmTitle.textContent = t(titleKey); confirmText.textContent = t(textKey, values);
      confirmation.showModal(); cancel.focus();
      return new Promise(resolve => pendingConfirm = resolve);
    }
    function finishConfirm(value) { const resolve = pendingConfirm; pendingConfirm = null; confirmation.close(); resolve?.(value); }
    cancel.addEventListener('click', () => finishConfirm(false)); accept.addEventListener('click', () => finishConfirm(true));
    confirmation.addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });

    function notify(keyOrError) { transport.toast(keyOrError); }
    async function copy(text, field, successKey) {
      try { await navigator.clipboard.writeText(text); notify(successKey); }
      catch {
        if (field) { field.focus(); field.select(); notify('cloud.copy.manual'); }
        else window.prompt(t('cloud.copy.prompt'), text);
      }
    }
    function selectedKey() { return activeInvites?.[`${selectedRole}_token`]; }
    function renderInvitation(invites, i18n) {
      language = i18n; activeInvites = invites;
      roleSelect.value = selectedRole;
      const key = selectedKey();
      linkInput.value = invitationUrl(location.origin, invitation.roomId, selectedRole, key);
      const isAgent = selectedRole !== 'viewer'; jsonField.hidden = !isAgent;
      if (isAgent) {
        const rest = restInvitation({ origin: location.origin, roomId: invitation.roomId, role: selectedRole, token: key, apiBase: apiBase() });
        jsonInput.value = JSON.stringify(rest, null, 2);
        $('agent-instructions').value = [t('cloud.invite.agentIntro'), restInstructions(rest)].join('\n\n');
      } else {
        jsonInput.value = '';
        $('agent-instructions').value = `${t('cloud.invite.viewerIntro')}\n\n${linkInput.value}`;
      }
      rotate.disabled = !!currentState?.expired || !!currentState?.deleting || deletingRoom;
    }
    function updateChrome(state, i18n) {
      language = i18n; currentState = state;
      const count = state.message_count ?? state.messages?.length ?? 0, limit = state.message_limit || 100;
      const locked = state.expired || state.deleting || deletingRoom || deletionInterrupted, full = count >= limit;
      summary.textContent = t('cloud.room.summary', { count: new Intl.NumberFormat(language.locale).format(count), limit: new Intl.NumberFormat(language.locale).format(limit), date: language.formatDateTime(state.expires_at) });
      readonly.hidden = !locked && !full;
      readonly.textContent = locked || full ? t(deletionInterrupted ? 'cloud.room.deleteInterrupted' : state.deleting || deletingRoom ? 'cloud.room.deleting' : state.expired ? 'cloud.room.expired' : 'cloud.room.full') : '';
      for (const id of ['start-button', 'pause-button', 'settings-button', 'message-input', 'send-button']) {
        const control = $(id);
        if (locked || full && ['start-button', 'message-input', 'send-button'].includes(id)) control.disabled = true;
      }
      deleteButton.disabled = deletingRoom;
      rotate.disabled = !!locked || deletingRoom;
      recovery.hidden = state.role !== 'owner';
      if (state.role === 'owner') {
        recoveryTitle.textContent = t('cloud.recovery.title'); recoveryHelp.textContent = t('cloud.recovery.help'); recoveryCopy.textContent = t('cloud.recovery.copy');
      }
      if (state.expired || state.deleting || full) $('control-help').textContent = readonly.textContent;
    }
    roleSelect.addEventListener('change', () => { selectedRole = roleSelect.value; if (activeInvites) renderInvitation(activeInvites, language); });
    recoveryCopy.addEventListener('click', () => copy(roomUrl('owner'), null, 'cloud.recovery.copied'));
    linkCopy.addEventListener('click', () => copy(linkInput.value, linkInput, 'cloud.invite.linkCopied'));
    jsonCopy.addEventListener('click', () => copy(jsonInput.value, jsonInput, 'cloud.invite.jsonCopied'));
    $('invite-dialog').addEventListener('close', () => { activeInvites = null; linkInput.value = ''; jsonInput.value = ''; });
    rotate.addEventListener('click', async () => {
      const role = selectedRole;
      if (!await confirmAction('cloud.invite.rotateTitle', 'cloud.invite.rotateConfirm', { role: t(`cloud.role.${role}`) })) return;
      rotate.disabled = true; roleSelect.disabled = true;
      const previousInvites = activeInvites;
      try {
        const rotated = await session.request('/api/invite', { role });
        if (closed) return;
        Object.assign(previousInvites, rotated);
        if (activeInvites === previousInvites && $('invite-dialog').open) renderInvitation(activeInvites, language);
        notify('cloud.invite.rotated');
      } catch (error) { if (!closed) notify(error); }
      finally { rotate.disabled = !!currentState?.expired || !!currentState?.deleting; roleSelect.disabled = false; }
    });
    deleteButton.addEventListener('click', async () => {
      if (deletingRoom || !await confirmAction('cloud.delete.title', 'cloud.delete.confirm')) return;
      deletingRoom = true; deletionInterrupted = false; updateChrome(currentState, language);
      try {
        await session.deleteRoom(); forgetRoom(recents, invitation.roomId);
        for (const role of ['owner', 'viewer', 'server_agent', 'client_agent']) clearSession(sessions, { roomId: invitation.roomId, role });
        await transport.close(); location.assign('/');
      } catch (error) { deletingRoom = false; deletionInterrupted = true; updateChrome(currentState, language); notify(error); }
    });

    const transport = {
      ...invitation, i18n: language,
      request: (path, body) => session.request(path, body),
      renderInvite: renderInvitation,
      updateChrome,
      viewerUrl: invites => invitationUrl(location.origin, invitation.roomId, 'viewer', invites.viewer_token),
      async close() { if (closed) return; closed = true; await session.close(); },
      leave() { location.assign('/'); },
      subscribe(onState, onError) {
        return session.subscribe(state => {
          if (closed || deletingRoom) return;
          gate.hidden = true; currentState = state;
          rememberRoom(recents, { ...invitation, topic: state.topic });
          onState(state);
        }, error => { if (!closed && !deletingRoom) { showGate(error); onError(error); } });
      },
    };
    globalThis.agentRoomTransport = transport;
    language.translateDocument(document);
    await import('/app.js');
  } catch (error) {
    if (session) try { await session.close(); } catch { /* Preserve the original failure. */ }
    showGate(error);
  }
}
if (typeof document !== 'undefined') startRoom().catch(() => {
  document.body.textContent = 'Unable to load the room. Reload to try again.';
});
