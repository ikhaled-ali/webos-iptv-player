import {
  EN_MESSAGES,
  type MessageCatalog,
  type MessageKey,
  type PluralCategory,
  type PluralMessage,
  type PluralMessageKey,
  type TextMessageKey,
} from './en';
import { BUNDLED_CATALOGS } from './catalogs';
import { pseudoLocalize } from './pseudo';
import { applyStylesheetDirection } from '../utils/stylesheet-direction';

export type { MessageKey, PluralMessageKey, TextMessageKey } from './en';
type Messages = Readonly<MessageCatalog>;
type Params = Record<string, string | number>;
type LocaleDefinition = {
  displayName: string;
  systemExact: readonly string[];
  systemPrefixes: readonly string[];
};

const LOCALES = {
  en: {
    displayName: 'English',
    systemExact: [],
    systemPrefixes: [],
  },
  ar: {
    displayName: 'العربية',
    systemExact: [],
    systemPrefixes: ['ar'],
  },
  de: {
    displayName: 'Deutsch',
    systemExact: [],
    systemPrefixes: ['de'],
  },
  es: {
    displayName: 'Español',
    systemExact: [],
    systemPrefixes: ['es'],
  },
  fr: {
    displayName: 'Français',
    systemExact: [],
    systemPrefixes: ['fr'],
  },
  it: {
    displayName: 'Italiano',
    systemExact: [],
    systemPrefixes: ['it'],
  },
  pl: {
    displayName: 'Polski',
    systemExact: [],
    systemPrefixes: ['pl'],
  },
  'pt-BR': {
    displayName: 'Português (Brasil)',
    systemExact: [],
    systemPrefixes: ['pt'],
  },
  ru: {
    displayName: 'Русский',
    systemExact: [],
    systemPrefixes: ['ru'],
  },
  tr: {
    displayName: 'Türkçe',
    systemExact: [],
    systemPrefixes: ['tr'],
  },
  uk: {
    displayName: 'Українська',
    systemExact: [],
    systemPrefixes: ['uk'],
  },
  'zh-CN': {
    displayName: '简体中文',
    systemExact: ['zh'],
    systemPrefixes: ['zh-cn', 'zh-sg', 'zh-hans'],
  },
} as const satisfies Record<string, LocaleDefinition>;

export type SupportedLocale = keyof typeof LOCALES;
export type LocalePreference = 'system' | SupportedLocale;
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system'
    || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, value));
}

export function localeOptions(): { value: SupportedLocale; label: string }[] {
  return (Object.keys(LOCALES) as SupportedLocale[])
    .map(value => ({ value, label: LOCALES[value].displayName }));
}

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

// Catalogs that arrived through their locale script (app build only).
const LOADED_CATALOGS_KEY = '__IPTV_LOCALES__';
const pendingLoads = new Map<SupportedLocale, Promise<boolean>>();

function catalogFor(locale: SupportedLocale): Messages | null {
  if (locale === DEFAULT_LOCALE) return EN_MESSAGES;
  const bundled = BUNDLED_CATALOGS[locale];
  if (bundled) return bundled;
  const loaded = typeof self === 'undefined'
    ? undefined
    : (self as unknown as Record<string, Record<string, Messages> | undefined>)[LOADED_CATALOGS_KEY];
  return loaded?.[locale] ?? null;
}

function loadLocaleScript(locale: SupportedLocale): Promise<boolean> {
  const pending = pendingLoads.get(locale);
  if (pending) return pending;
  const load = new Promise<boolean>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const script = document.createElement('script');
    script.src = `js/locales/${locale}.js`;
    script.onload = () => resolve(catalogFor(locale) !== null);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  }).then((loaded) => {
    // A failed load may be retried later (e.g. from Settings).
    if (!loaded) pendingLoads.delete(locale);
    return loaded;
  });
  pendingLoads.set(locale, load);
  return load;
}

/**
 * Makes `locale`'s catalog available, loading its script when it is not
 * bundled. Resolves to the locale to apply: `locale`, or English when its
 * catalog could not be loaded.
 */
export async function loadLocale(locale: SupportedLocale): Promise<SupportedLocale> {
  if (catalogFor(locale) || await loadLocaleScript(locale)) return locale;
  return DEFAULT_LOCALE;
}

function pseudoLocaleRequested(): boolean {
  return typeof location !== 'undefined' && /(?:^|[?&])pseudo=1(?:&|$)/.test(location.search);
}

export function resolveLocale(
  preference: LocalePreference,
  browserLanguage = typeof navigator === 'undefined' ? DEFAULT_LOCALE : navigator.language,
): SupportedLocale {
  if (preference !== 'system') return preference;
  const language = browserLanguage.toLowerCase();
  for (const locale of Object.keys(LOCALES) as SupportedLocale[]) {
    const definition = LOCALES[locale];
    if (definition.systemExact.some(value => language === value)
        || definition.systemPrefixes.some(prefix =>
          language === prefix || language.startsWith(`${prefix}-`))) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

const RTL_LOCALES: readonly SupportedLocale[] = ['ar'];

export function isRtlLocale(locale: SupportedLocale = currentLocale): boolean {
  return RTL_LOCALES.indexOf(locale) >= 0;
}

// Arabic shows Western digits (an approved product choice), so number
// formatting pins the Latin numbering system.
function intlLocale(locale: SupportedLocale): string {
  return locale === 'ar' ? 'ar-u-nu-latn' : locale;
}

export function setLocale(locale: SupportedLocale): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') {
    const pseudo = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested();
    document.documentElement.lang = pseudo ? 'en-XA' : locale;
    const rtl = !pseudo && isRtlLocale(locale);
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    applyStylesheetDirection(rtl);
  }
}

export async function initLocale(preference: LocalePreference): Promise<void> {
  setLocale(await loadLocale(resolveLocale(preference)));
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  const locale = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested()
    ? DEFAULT_LOCALE
    : currentLocale;
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

export function t(key: TextMessageKey, params?: Params): string {
  let message = (catalogFor(currentLocale) ?? EN_MESSAGES)[key] as string;
  if (__ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested()) {
    message = pseudoLocalize(EN_MESSAGES[key]);
  }
  if (!params) return message;
  return interpolate(message, params);
}

export function tp(key: PluralMessageKey, count: number, params?: Params): string {
  const pseudo = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested();
  const locale = pseudo ? DEFAULT_LOCALE : currentLocale;
  const forms = (catalogFor(locale) ?? EN_MESSAGES)[key] as PluralMessage;
  const category = new Intl.PluralRules(locale).select(count);
  const message = forms[category] ?? forms.other;
  return interpolate(pseudo ? pseudoLocalize(message) : message, { ...params, count });
}

function interpolate(message: string, params: Params): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    params[name] === undefined ? token : String(params[name]));
}

function placeholders(message: string): string[] {
  const names: string[] = [];
  const pattern = /\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) names.push(match[1]);
  return names.sort();
}

export function validateTranslations(): string[] {
  const errors: string[] = [];
  const keys = Object.keys(EN_MESSAGES) as MessageKey[];
  for (const locale of Object.keys(LOCALES) as SupportedLocale[]) {
    const messages = catalogFor(locale);
    if (!messages) {
      errors.push(`${locale} catalog is not loaded`);
      continue;
    }
    for (const key of keys) {
      const source = EN_MESSAGES[key];
      const value = messages[key];
      if (typeof source === 'string') {
        const message = value as string;
        if (!message.trim()) {
          errors.push(`${locale}:${key} is empty`);
          continue;
        }
        const expected = placeholders(source).join(',');
        const actual = placeholders(message).join(',');
        if (actual !== expected) {
          errors.push(`${locale}:${key} placeholders [${actual}] do not match [${expected}]`);
        }
      } else {
        const forms = value as PluralMessage;
        const expected = placeholders(source.other).join(',');
        for (const category of Object.keys(forms) as PluralCategory[]) {
          const message = forms[category];
          if (!message) continue;
          if (!message.trim()) errors.push(`${locale}:${key}:${category} is empty`);
          const actual = placeholders(message).join(',');
          if (actual !== expected) {
            errors.push(`${locale}:${key}:${category} placeholders [${actual}] do not match [${expected}]`);
          }
        }
      }
    }
  }
  return errors;
}
