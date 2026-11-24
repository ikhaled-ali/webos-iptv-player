// Languages the Search mic's recognizer can be set to, by BCP 47 tag, each
// named in its own language. 'app' follows the app's language.
export const VOICE_LANGUAGES = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'ar-SA', label: 'العربية (السعودية)' },
  { tag: 'ar-AE', label: 'العربية (الإمارات)' },
  { tag: 'ar-EG', label: 'العربية (مصر)' },
  { tag: 'ar-KW', label: 'العربية (الكويت)' },
  { tag: 'ar-JO', label: 'العربية (الأردن)' },
  { tag: 'ar-LB', label: 'العربية (لبنان)' },
  { tag: 'ar-MA', label: 'العربية (المغرب)' },
  { tag: 'de-DE', label: 'Deutsch' },
  { tag: 'es-ES', label: 'Español (España)' },
  { tag: 'es-MX', label: 'Español (México)' },
  { tag: 'fr-FR', label: 'Français' },
  { tag: 'it-IT', label: 'Italiano' },
  { tag: 'pl-PL', label: 'Polski' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'ru-RU', label: 'Русский' },
  { tag: 'tr-TR', label: 'Türkçe' },
  { tag: 'uk-UA', label: 'Українська' },
  { tag: 'zh-CN', label: '简体中文' },
] as const;

export type VoiceLanguageTag = typeof VOICE_LANGUAGES[number]['tag'];
export type VoiceLanguagePreference = 'app' | VoiceLanguageTag;

export function isVoiceLanguagePreference(value: unknown): value is VoiceLanguagePreference {
  return value === 'app' || VOICE_LANGUAGES.some(language => language.tag === value);
}
