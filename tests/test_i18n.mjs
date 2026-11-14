import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleUrl = new URL('../agent_debug_room/static/i18n.mjs', import.meta.url);
const catalogUrl = locale => new URL(`../agent_debug_room/static/locales/${locale}.json`, import.meta.url);
const readCatalog = async locale => JSON.parse(await readFile(catalogUrl(locale), 'utf8'));
const apiCodes = 'invalid_text unauthorized invalid_config invalid_max_turns invalid_message message_id_conflict room_paused wrong_turn invalid_action unsupported_transfer_encoding unsupported_content_type content_length_required invalid_content_length request_too_large invalid_json invalid_cursor agent_required owner_required not_found internal_error'.split(' ');
const placeholders = value => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
const memoryStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

// Removing browser language matching, fallback, or live switching must fail these tests.
test('locale matching handles language regions, Chinese scripts, and unsupported browsers', async () => {
  const { resolveLocale } = await import(moduleUrl);
  assert.equal(resolveLocale(['ja-JP', 'en-US']), 'ja');
  assert.equal(resolveLocale(['it-IT', 'es-MX']), 'es');
  assert.equal(resolveLocale(['zh-Hant-HK']), 'zh-TW');
  assert.equal(resolveLocale(['zh-HK']), 'zh-TW');
  assert.equal(resolveLocale(['zh-SG']), 'zh-CN');
  assert.equal(resolveLocale(['pt-PT']), 'pt-BR');
  assert.equal(resolveLocale(['AR-eg']), 'ar');
  assert.equal(resolveLocale(['xx-XX']), 'en');
});

test('ten real catalogs have matching keys and interpolation parameters', async () => {
  const { LOCALES } = await import(moduleUrl);
  assert.deepEqual(LOCALES.map(locale => locale.code), ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ar']);
  const english = await readCatalog('en');
  assert.ok(Object.keys(english).length >= 80);
  for (const code of apiCodes) assert.equal(typeof english[`api.${code}`], 'string');
  for (const { code } of LOCALES) {
    const catalog = await readCatalog(code);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), code);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${code}: ${key}`);
      assert.ok(value.trim(), `${code}: ${key}`);
      assert.deepEqual(placeholders(value), placeholders(english[key]), `${code}: ${key}`);
    }
    if (code !== 'en') {
      const translated = Object.keys(english).filter(key => catalog[key] !== english[key]).length;
      assert.ok(translated / Object.keys(english).length > 0.9, `${code} must provide actual translations`);
    }
  }
});

test('saved explicit choice wins, changing locale persists and updates document direction', async () => {
  const { createI18n, STORAGE_KEY } = await import(moduleUrl);
  const storage = memoryStorage({ [STORAGE_KEY]: 'zh-TW' });
  const document = { documentElement: { lang: 'en', dir: 'ltr' } };
  const i18n = await createI18n({ loadCatalog: readCatalog, storage, languages: ['ja-JP'], document });
  assert.equal(i18n.locale, 'zh-TW');
  assert.equal(document.documentElement.lang, 'zh-TW');
  let changes = 0;
  i18n.onChange(() => changes++);
  await i18n.setLocale('ar');
  assert.equal(i18n.locale, 'ar');
  assert.equal(document.documentElement.lang, 'ar');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(storage.getItem(STORAGE_KEY), 'ar');
  assert.equal(changes, 1);
  await i18n.setLocale('de');
  assert.equal(document.documentElement.dir, 'ltr');
  assert.equal(changes, 2);
});

test('missing catalog and individual key fall back to English without corrupting placeholders', async () => {
  const { createI18n } = await import(moduleUrl);
  const i18n = await createI18n({
    loadCatalog: async locale => locale === 'en' ? readCatalog(locale) : locale === 'fr' ? { 'status.turn': 'Tour de {name}' } : Promise.reject(new Error('offline')),
    languages: ['fr'], storage: memoryStorage(),
  });
  assert.equal(i18n.t('status.turn', { name: '<script>$&</script>' }), 'Tour de <script>$&</script>');
  assert.equal(i18n.t('login.key'), 'Access key');
  assert.equal(i18n.t('unknown.key'), 'unknown.key');
  await i18n.setLocale('ja');
  assert.equal(i18n.locale, 'en');
  assert.equal(i18n.t('login.key'), 'Access key');
});

test('language choice works with blocked storage and uses latest requested locale', async () => {
  const { createI18n } = await import(moduleUrl);
  let finishArabic;
  const arabic = new Promise(resolve => finishArabic = resolve);
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const i18n = await createI18n({ loadCatalog: locale => locale === 'ar' ? arabic : readCatalog(locale), storage, languages: ['en'] });
  const first = i18n.setLocale('ar');
  await i18n.setLocale('ja');
  finishArabic(await readCatalog('ar'));
  await first;
  assert.equal(i18n.locale, 'ja');
});

test('selected locale controls dates, role labels, API errors and exported transcript while preserving chat', async () => {
  const { createI18n, formatTranscript } = await import(moduleUrl);
  const i18n = await createI18n({ loadCatalog: readCatalog, languages: ['de'], storage: memoryStorage() });
  const when = '2026-11-14T10:20:30Z';
  assert.equal(i18n.formatTime(when), new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(when)));
  assert.equal(i18n.formatTime('bad date'), '');
  assert.equal(i18n.errorMessage({ code: 'wrong_turn', error: 'English backend message' }), i18n.t('api.wrong_turn'));
  assert.equal(i18n.errorMessage({ code: 'unknown', error: 'Future backend error' }), 'Future backend error');
  const content = '原文 <script>alert(1)</script> / مرحبًا **verbatim**';
  const messages = [{ id: 1, role: 'server', name: 'English backend name', created_at: when, content }];
  const before = JSON.stringify(messages);
  const markdown = formatTranscript({ topic: '' }, messages, i18n);
  assert.ok(markdown.startsWith(`# ${i18n.t('export.title')}\n`));
  assert.ok(markdown.includes(i18n.t('role.server')));
  assert.ok(markdown.includes(i18n.formatDateTime(when)));
  assert.ok(markdown.includes(content));
  assert.ok(!markdown.includes('English backend name'));
  assert.equal(JSON.stringify(messages), before);
});

test('document translation updates text and accessible attributes through safe DOM properties', async () => {
  const { createI18n } = await import(moduleUrl);
  const text = { dataset: { i18n: 'login.key' }, textContent: '' };
  const attributes = new Map([
    ['data-i18n-placeholder', 'login.placeholder'],
    ['data-i18n-aria-label', 'settings.close'],
    ['data-i18n-title', 'action.invite'],
  ]);
  const input = { getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value) };
  const root = { querySelectorAll: selector => selector === '[data-i18n]' ? [text] : [input] };
  const i18n = await createI18n({ loadCatalog: readCatalog, languages: ['ar'], storage: memoryStorage() });
  i18n.translateDocument(root);
  assert.equal(text.textContent, 'مفتاح الوصول');
  assert.equal(attributes.get('placeholder'), i18n.t('login.placeholder'));
  assert.equal(attributes.get('aria-label'), i18n.t('settings.close'));
  assert.equal(attributes.get('title'), i18n.t('action.invite'));
  await i18n.setLocale('en');
  i18n.translateDocument(root);
  assert.equal(text.textContent, 'Access key');
  assert.equal(attributes.get('placeholder'), 'Paste the room access key');
});

function formInput({ value = '', required = false, type = 'text', limit, maxLength = -1, min = 1, max = 20 } = {}) {
  let message = '';
  return {
    value, required, type, maxLength, dataset: limit ? { maxCodepoints: String(limit) } : {},
    setCustomValidity(text) { message = text; },
    get validationMessage() { return message; },
    get validity() {
      const valueMissing = required && !this.value;
      const invalidNumber = type === 'number' && this.value !== '' && (!Number.isInteger(Number(this.value)) || Number(this.value) < min || Number(this.value) > max);
      return { valueMissing, customError: !!message, valid: !valueMissing && !invalidNumber && !message };
    },
  };
}
function formHarness(inputs, submit) {
  return {
    querySelectorAll: () => inputs,
    reportValidity: () => inputs.every(input => input.validity.valid),
    requestSubmit(validate) { if (validate(this)) submit(); },
  };
}

test('editable HTML fields allow the full non-BMP codepoint boundary instead of truncating at half', async () => {
  for (const [filename, fields] of [
    ['../agent_debug_room/static/index.html', { 'message-input': 16000, 'topic-input': 200, 'context-input': 24000 }],
    ['../web/index.html', { 'create-topic': 200, 'create-context': 24000 }],
  ]) {
    const html = await readFile(new URL(filename, import.meta.url), 'utf8');
    for (const [id, limit] of Object.entries(fields)) {
      const markup = html.match(new RegExp(`<(?:input|textarea)\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
      assert.ok(markup, id);
      const nativeLimit = Number(markup.match(/\bmaxlength="(\d+)"/)?.[1]);
      assert.ok(nativeLimit >= '😀'.repeat(limit).length, `${id} must accept ${limit} emoji in native input`);
      assert.equal(Number(markup.match(/\bdata-max-codepoints="(\d+)"/)?.[1]), limit, id);
    }
  }
});

test('real form validator submits 16000 emoji unchanged and rejects 16001 without losing the draft', async () => {
  const { createI18n, validateFormInputs } = await import(moduleUrl);
  const i18n = await createI18n({ loadCatalog: readCatalog, languages: ['en'], storage: memoryStorage() });
  const input = formInput({ limit: 16000, maxLength: 32000 });
  const sent = [], form = formHarness([input], () => sent.push(input.value));
  const atBoundary = '😀'.repeat(16000);
  input.value = atBoundary;
  form.requestSubmit(form => validateFormInputs(form, i18n));
  assert.deepEqual(sent, [atBoundary]);
  input.value += '😀';
  form.requestSubmit(form => validateFormInputs(form, i18n));
  assert.equal(sent.length, 1);
  assert.equal(input.validationMessage, i18n.t('api.invalid_text'));
  assert.equal(Array.from(input.value).length, 16001);
  input.value = atBoundary;
  form.requestSubmit(form => validateFormInputs(form, i18n));
  assert.deepEqual(sent, [atBoundary, atBoundary]);
  assert.equal(input.validationMessage, '');
});

test('topic and context codepoint limits retain required, integer, and localized validity behavior', async () => {
  const { createI18n, setInputValidity } = await import(moduleUrl);
  const i18n = await createI18n({ loadCatalog: readCatalog, languages: ['zh-CN'], storage: memoryStorage() });
  for (const limit of [200, 24000]) {
    const input = formInput({ value: '😀'.repeat(limit), limit });
    assert.equal(setInputValidity(input, i18n), true);
    input.value += 'a';
    assert.equal(setInputValidity(input, i18n), false);
    assert.equal(input.validationMessage, i18n.t('api.invalid_text'));
  }
  const required = formInput({ required: true, limit: 200 });
  assert.equal(setInputValidity(required, i18n), false);
  assert.equal(required.validationMessage, i18n.t('validation.required'));
  required.value = '😀';
  assert.equal(setInputValidity(required, i18n), true);
  const turns = formInput({ value: '1.5', required: true, type: 'number' });
  assert.equal(setInputValidity(turns, i18n), false);
  assert.equal(turns.validationMessage, i18n.t('api.invalid_max_turns'));
  turns.value = '1';
  assert.equal(setInputValidity(turns, i18n), true);
});
