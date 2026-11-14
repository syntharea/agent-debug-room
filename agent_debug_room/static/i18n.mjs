export const STORAGE_KEY = 'agent-debug-room-locale';
export const LOCALES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ar', name: 'العربية' },
]);

export function resolveLocale(languages = []) {
  for (const language of languages) {
    const tag = String(language).replaceAll('_', '-').toLowerCase();
    const exact = LOCALES.find(locale => locale.code.toLowerCase() === tag);
    if (exact) return exact.code;
    const base = tag.split('-')[0];
    if (base === 'zh') return /(?:^|-)(hant|tw|hk|mo)(?:-|$)/.test(tag) ? 'zh-TW' : 'zh-CN';
    const match = LOCALES.find(locale => locale.code.toLowerCase().split('-')[0] === base);
    if (match) return match.code;
  }
  return 'en';
}

async function fetchCatalog(locale) {
  const response = await fetch(`/locales/${locale}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Locale catalog unavailable');
  return response.json();
}

export async function createI18n({ loadCatalog = fetchCatalog, storage, languages = [], document } = {}) {
  const english = await loadCatalog('en');
  let locale = 'en', catalog = english, request = 0;
  const cache = new Map([['en', english]]), listeners = new Set();
  let saved;
  try { saved = storage?.getItem(STORAGE_KEY); } catch { /* Language selection still works without storage. */ }

  const i18n = {
    get locale() { return locale; },
    get dir() { return locale === 'ar' ? 'rtl' : 'ltr'; },
    t(key, values = {}) {
      const text = typeof catalog[key] === 'string' ? catalog[key] : english[key] ?? key;
      return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
    },
    async setLocale(value, persist = true) {
      const version = ++request;
      let next = resolveLocale([value]), nextCatalog;
      try {
        nextCatalog = cache.get(next) || await loadCatalog(next);
        cache.set(next, nextCatalog);
      } catch { next = 'en'; nextCatalog = english; }
      if (version !== request) return;
      locale = next; catalog = nextCatalog;
      if (document) {
        document.documentElement.lang = locale;
        document.documentElement.dir = i18n.dir;
      }
      if (persist) try { storage?.setItem(STORAGE_KEY, locale); } catch { /* Browsers may block local storage. */ }
      for (const listener of listeners) listener(locale);
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    translateDocument(root) {
      root.querySelectorAll('[data-i18n]').forEach(node => node.textContent = i18n.t(node.dataset.i18n));
      for (const attribute of ['placeholder', 'aria-label', 'title']) {
        root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(node => node.setAttribute(attribute, i18n.t(node.getAttribute(`data-i18n-${attribute}`))));
      }
    },
    formatTime(value) { return formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }); },
    formatDateTime(value) { return formatDate(value, { dateStyle: 'medium', timeStyle: 'medium' }); },
    errorMessage(value, status) {
      if (value?.code && typeof english[`api.${value.code}`] === 'string') return i18n.t(`api.${value.code}`);
      return typeof value?.error === 'string' ? value.error : i18n.t('error.request', { status: status || '—' });
    },
  };
  function formatDate(value, options) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale, options).format(date);
  }
  await i18n.setLocale(saved && LOCALES.some(item => item.code === saved) ? saved : resolveLocale(languages), false);
  return i18n;
}

export function formatTranscript(room, messages, i18n) {
  return `# ${room?.topic || i18n.t('export.title')}\n\n${messages.map(message => {
    const role = ['server', 'client', 'human', 'system'].includes(message.role) ? message.role : 'system';
    return `## ${i18n.t(`role.${role}`)} · ${i18n.formatDateTime(message.created_at)}\n\n${message.content}`;
  }).join('\n\n---\n\n')}`;
}

export function setInputValidity(input, i18n) {
  input.setCustomValidity('');
  const limit = Number(input.dataset.maxCodepoints);
  if (input.validity.valueMissing) input.setCustomValidity(i18n.t('validation.required'));
  else if (limit && Array.from(input.value).length > limit) input.setCustomValidity(i18n.t('api.invalid_text'));
  else if (input.type === 'number' && !input.validity.valid) input.setCustomValidity(i18n.t('api.invalid_max_turns'));
  return input.validity.valid;
}

export function validateFormInputs(form, i18n) {
  form.querySelectorAll('input, textarea').forEach(input => setInputValidity(input, i18n));
  return form.reportValidity();
}
