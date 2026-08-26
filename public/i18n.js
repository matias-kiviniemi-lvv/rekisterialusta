"use strict";

export const DEFAULT_LOCALE = "fi";
export const SUPPORTED_LOCALES = Object.freeze(["fi"]);

export function normalizeLocale(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0] || null; }
  catch { return null; }
}

export function resolveLocale({ query = "", stored = null, languages = [] } = {}) {
  const requested = [new URLSearchParams(query).get("lang"), stored, ...languages];
  for (const candidate of requested) {
    const normalized = normalizeLocale(candidate);
    if (!normalized) continue;
    const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;
    const base = normalized.split("-")[0];
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export function createI18n(locale, catalog, onMissing = () => {}) {
  const resolvedLocale = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const t = (key, params = {}) => {
    const template = catalog.messages[key];
    if (template === undefined) {
      onMissing(key);
      return key;
    }
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : `{${name}}`);
  };
  const fromSource = (source) => {
    const key = catalog.sourceKeys[source];
    return key ? t(key) : source;
  };
  return {
    locale: resolvedLocale,
    t,
    fromSource,
    number: new Intl.NumberFormat(resolvedLocale),
    date: new Intl.DateTimeFormat(resolvedLocale),
    plural: new Intl.PluralRules(resolvedLocale),
  };
}

export function translateDocument(root, i18n) {
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = i18n.t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
    element.setAttribute("placeholder", i18n.t(element.dataset.i18nPlaceholder));
  }
  document.documentElement.lang = i18n.locale;
}
