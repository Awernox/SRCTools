/**
 * Localisation.
 *
 * `en` defines the key set; every other language is a partial of it, so an
 * untranslated string falls back to English instead of rendering a raw key.
 * Lookup is a plain object index — no runtime key parsing, no async loading, and
 * all four catalogues ship inside the bundle.
 *
 * This module deliberately imports nothing from the stores: the session store
 * imports `setLanguage` from here, and a cycle would leave one of the two
 * half-initialised. Persistence therefore lives in the session store, and this
 * module only holds what is currently displayed.
 */

import { create } from 'zustand';

import { en, type TranslationKey } from './en';
import { ru } from './ru';
import { uk } from './uk';
import { es } from './es';

/**
 * The key set, with plain `string` values.
 *
 * `en` is `as const`, so `typeof en` would type each value as the English
 * literal itself and reject every translation. Widening here keeps the keys
 * exact — a typo in a catalogue is still a compile error — while letting the
 * values be any string.
 *
 * The unit keys are intersected in as optional extras. English needs only
 * `one` and `other`, so `en` does not define `unit.day.few`; Russian and
 * Ukrainian do need it. Declaring the whole grid here lets those catalogues
 * carry the forms their grammar requires without adding inert entries to
 * English that nothing would ever select.
 */
export type Catalogue = Record<TranslationKey, string> &
  Partial<Record<UnitKey, string>>;
export type { TranslationKey };

export const LANGUAGES = ['en', 'ru', 'uk', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

const CATALOGUES: Record<Language, Partial<Catalogue>> = { en, ru, uk, es };

/** Native name of each language, for the picker. Never translated. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
  uk: 'Українська',
  es: 'Español',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Substitutes `{name}` placeholders.
 *
 * A placeholder with no matching value is left in place rather than blanked:
 * `{count}` on screen is an obvious bug, an empty gap is not.
 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

export type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>,
) => string;

function makeTranslator(lang: Language): Translate {
  const catalogue = CATALOGUES[lang];
  return (key, vars) => interpolate(catalogue[key] ?? en[key], vars);
}

interface I18nState {
  lang: Language;
  t: Translate;
}

const useI18n = create<I18nState>(() => ({
  lang: DEFAULT_LANGUAGE,
  t: makeTranslator(DEFAULT_LANGUAGE),
}));

/**
 * Switches the displayed language. Persistence is the caller's job — the
 * session store writes the preference and then calls this.
 */
export function setLanguage(lang: Language): void {
  if (useI18n.getState().lang === lang) return;
  useI18n.setState({ lang, t: makeTranslator(lang) });
  document.documentElement.lang = lang;
}

/** Re-renders the caller whenever the language changes. */
export function useT(): Translate {
  return useI18n((s) => s.t);
}

/** The active language, for components that need to branch on it. */
export function useLanguage(): Language {
  return useI18n((s) => s.lang);
}

/** The active language outside React — for `Intl` calls in formatters. */
export function activeLanguage(): Language {
  return useI18n.getState().lang;
}

/**
 * Nouns that are counted on screen.
 *
 * Each needs one catalogue entry per plural category the language uses, which
 * is why the list is closed: a noun added here without its entries is a compile
 * error in `en.ts` rather than a `unit.thing.few` appearing in the interface.
 */
export const PLURAL_NOUNS = [
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
  'run',
  'action',
  'game',
  'time',
  'decision',
  'match',
  'operation',
  'finding',
  'link',
  'entry',
  'expiredEntry',
  'batch',
  'critical',
  'warning',
  'note',
  'row',
] as const;

export type PluralNoun = (typeof PLURAL_NOUNS)[number];

/**
 * Every plural category any of the four languages can select.
 *
 * English and Spanish use `one`/`other`; Russian and Ukrainian add `few` and
 * `many`. `zero` and `two` are unused by these four but cost nothing to allow
 * and would be needed by any language added later.
 */
type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** `unit.day.few` and friends — the full grid, as optional catalogue keys. */
export type UnitKey = `unit.${PluralNoun}.${PluralCategory}`;

/**
 * Cached per language: constructing `Intl.PluralRules` is not free, and this is
 * called for every counted string in a table.
 */
const pluralRules = new Map<Language, Intl.PluralRules>();

function rulesFor(lang: Language): Intl.PluralRules {
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(lang);
    pluralRules.set(lang, rules);
  }
  return rules;
}

/**
 * Counts a noun correctly in the active language.
 *
 * English and Spanish need two forms; Russian and Ukrainian need three, and
 * pick between them on the last digits — 1 час, 2 часа, 5 часов, 21 час. A
 * `count === 1 ? noun : noun + 's'` cannot express that, which is why every
 * counted string goes through `Intl.PluralRules` instead.
 *
 * Falls back to the `other` form when a catalogue is missing the category the
 * rules selected, so a partial translation reads awkwardly rather than blankly.
 */
export function pluralize(count: number, noun: PluralNoun): string {
  const lang = useI18n.getState().lang;
  const category = rulesFor(lang).select(count);
  const catalogue = CATALOGUES[lang];
  const exact: UnitKey = `unit.${noun}.${category}`;
  const fallback: UnitKey = `unit.${noun}.other`;
  const template =
    catalogue[exact] ??
    catalogue[fallback] ??
    en[exact as TranslationKey] ??
    en[fallback as TranslationKey];
  return interpolate(template, { count: count.toLocaleString(lang) });
}

/**
 * Translation outside React — notification bodies, the watcher, anything built
 * in an event handler. Reads the same state the hook does.
 */
export const t: Translate = (key, vars) => useI18n.getState().t(key, vars);

/**
 * Best guess from the OS locale, used only when nothing is stored yet.
 * `navigator.language` is a BCP-47 tag such as `ru-RU`, so only the primary
 * subtag matters.
 */
export function detectLanguage(): Language {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const primary = tag.toLowerCase().split('-')[0];
    if (isLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}
