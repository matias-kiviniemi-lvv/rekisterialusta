import type { LocalizedText, LocaleConfig } from "./registry-config.ts";

export const DEFAULT_LOCALE_CONFIG: LocaleConfig = Object.freeze({ supported: Object.freeze(["fi"]), default: "fi" });

export function normalizeLocale(value: string): string | null {
  try {
    return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

export function validateLocaleConfig(config: LocaleConfig): void {
  if (config.supported.length === 0) throw new Error("supported locales must not be empty");
  const normalized = config.supported.map((locale) => normalizeLocale(locale));
  if (normalized.some((locale) => locale === null)) throw new Error("supported locales contain an invalid locale");
  if (new Set(normalized).size !== normalized.length) throw new Error("supported locales contain duplicates after normalization");
  const defaultLocale = normalizeLocale(config.default);
  if (!defaultLocale || !normalized.includes(defaultLocale)) throw new Error("default locale must be supported");
}

export function resolveRequestedLocale(requested: readonly (string | null | undefined)[], policy: LocaleConfig = DEFAULT_LOCALE_CONFIG): string {
  const supported = policy.supported.map((locale) => normalizeLocale(locale)!);
  for (const candidate of requested) {
    if (!candidate) continue;
    const normalized = normalizeLocale(candidate);
    if (!normalized) continue;
    const exact = supported.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;
    const base = normalized.split("-")[0]!;
    const baseMatch = supported.find((locale) => locale.toLowerCase() === base.toLowerCase());
    if (baseMatch) return baseMatch;
  }
  return normalizeLocale(policy.default)!;
}

export function validateLocalizedText(text: LocalizedText, label: string): void {
  const source = normalizeLocale(text.sourceLocale);
  if (!source) throw new Error(`${label} has an invalid source locale`);
  const seen = new Set<string>();
  for (const [locale, value] of Object.entries(text.values)) {
    const normalized = normalizeLocale(locale);
    if (!normalized) throw new Error(`${label} has an invalid locale ${locale}`);
    if (seen.has(normalized)) throw new Error(`${label} has duplicate locale ${normalized}`);
    seen.add(normalized);
    if (!value.trim()) throw new Error(`${label} has a blank ${normalized} translation`);
  }
  if (!seen.has(source)) throw new Error(`${label} requires its source-locale value`);
  if (!seen.has("fi")) throw new Error(`${label} requires Finnish`);
}

export interface ResolvedText { readonly value: string; readonly locale: string; readonly fallback: boolean }

/** Resolve without ever changing the entity's stable id. Scalars are treated as legacy Finnish copy. */
export function resolveLocalizedText(text: LocalizedText | undefined, scalar: string, locale: string): ResolvedText {
  if (!text) return { value: scalar, locale: "fi", fallback: locale !== "fi" };
  const requested = normalizeLocale(locale) ?? locale;
  const exactKey = Object.keys(text.values).find((key) => normalizeLocale(key) === requested);
  const base = requested.split("-")[0]!;
  const baseKey = Object.keys(text.values).find((key) => normalizeLocale(key) === base);
  const sourceKey = Object.keys(text.values).find((key) => normalizeLocale(key) === normalizeLocale(text.sourceLocale));
  const key = exactKey ?? baseKey ?? sourceKey!;
  return { value: text.values[key]!, locale: normalizeLocale(key)!, fallback: normalizeLocale(key) !== requested };
}
