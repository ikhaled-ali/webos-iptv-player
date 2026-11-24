// Every translated catalog, bundled. Unit tests use this module as is; the app
// build swaps it for catalogs-lazy.ts, so each catalog ships as its own script
// (js/locales/<locale>.js) and only the active language is ever parsed.
import type { MessageCatalog } from './en';
import { AR_MESSAGES } from './ar';
import { DE_MESSAGES } from './de';
import { ES_MESSAGES } from './es';
import { FR_MESSAGES } from './fr';
import { IT_MESSAGES } from './it';
import { PL_MESSAGES } from './pl';
import { PT_BR_MESSAGES } from './pt-BR';
import { RU_MESSAGES } from './ru';
import { TR_MESSAGES } from './tr';
import { UK_MESSAGES } from './uk';
import { ZH_CN_MESSAGES } from './zh-CN';

export const BUNDLED_CATALOGS: Record<string, Readonly<MessageCatalog>> = {
  ar: AR_MESSAGES,
  de: DE_MESSAGES,
  es: ES_MESSAGES,
  fr: FR_MESSAGES,
  it: IT_MESSAGES,
  pl: PL_MESSAGES,
  'pt-BR': PT_BR_MESSAGES,
  ru: RU_MESSAGES,
  tr: TR_MESSAGES,
  uk: UK_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
};
