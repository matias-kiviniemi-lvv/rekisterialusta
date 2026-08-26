export const DEFAULT_LOCALE: "fi";
export const SUPPORTED_LOCALES: readonly ["fi"];
export function normalizeLocale(value: unknown): string | null;
export function resolveLocale(input?: { query?: string; stored?: string | null; languages?: readonly string[] }): string;
export function createI18n(
  locale: string,
  catalog: { messages: Readonly<Record<string, string>>; sourceKeys: Readonly<Record<string, string>> },
  onMissing?: (key: string) => void,
): {
  locale: string;
  t(key: string, params?: Readonly<Record<string, unknown>>): string;
  fromSource(source: string): string;
  number: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  plural: Intl.PluralRules;
};
export function translateDocument(root: ParentNode, i18n: ReturnType<typeof createI18n>): void;
