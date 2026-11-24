const LATIN_RANGES = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
const CYRILLIC_RANGES = '\\u0400-\\u0481\\u048A-\\u052F\\uA640-\\uA66E\\uA67F-\\uA69D';
const ARABIC_RANGES = '\\u0620-\\u063F\\u0641-\\u064A\\u066E-\\u066F\\u0671-\\u06D3\\u06D5\\u06EE-\\u06EF\\u06FA-\\u06FC\\u06FF\\u0750-\\u077F\\u08A0-\\u08B4\\u08B6-\\u08C7';
const HAN_RANGES = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const LETTER_RANGES = `${LATIN_RANGES}${CYRILLIC_RANGES}${ARABIC_RANGES}${HAN_RANGES}`;

let supportsUnicodeProperties = true;
// Runtime feature detection: Chrome 53 throws when compiling property escapes.
try {
  new RegExp('\\p{L}', 'u');
} catch {
  supportsUnicodeProperties = false;
}

function createUnicodeRegExp(
  unicodePattern: string,
  fallbackPattern: string,
  flags: string,
): RegExp {
  return new RegExp(
    supportsUnicodeProperties ? unicodePattern : fallbackPattern,
    flags,
  );
}

const DIACRITIC_MARKS_RE = createUnicodeRegExp(
  '[\\p{Diacritic}ٕٓٔ]',
  '[\\u0300-\\u036F\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u08D3-\\u08E1\\u08E3-\\u08FF]',
  'gu',
);
const COMBINING_DIACRITIC_MARKS_RE = /[\u0300-\u036F]/gu;

const LETTER_OR_NUMBER_RE = createUnicodeRegExp(
  '[\\p{L}\\p{N}]',
  `[0-9${LETTER_RANGES}]`,
  'u',
);

const LETTER_NUMBER_SEPARATOR_RE = createUnicodeRegExp(
  '[^\\p{L}\\p{N}]+',
  `[^0-9${LETTER_RANGES}]+`,
  'u',
);

// The same separators, global, for scanning token bounds without allocating tokens.
export const LETTER_NUMBER_SEPARATOR_GLOBAL_RE = new RegExp(LETTER_NUMBER_SEPARATOR_RE.source, 'gu');

const LETTER_NUMBER_PLUS_SEPARATOR_RE = createUnicodeRegExp(
  '[^\\p{L}\\p{N}+]+',
  `[^+0-9${LETTER_RANGES}]+`,
  'u',
);

const LETTER_NUMBER_WORD_RE = createUnicodeRegExp(
  '^[\\p{L}\\p{N}]+$',
  `^[0-9${LATIN_RANGES}${CYRILLIC_RANGES}]+$`,
  'u',
);

const ARABIC_OR_HAN_RE = createUnicodeRegExp(
  '[\\p{sc=Han}\\p{sc=Arabic}]',
  `[${ARABIC_RANGES}${HAN_RANGES}]`,
  'u',
);

export function stripDiacritics(value: string): string {
  return value.replace(DIACRITIC_MARKS_RE, '');
}

export function stripCombiningDiacritics(value: string): string {
  return value.replace(COMBINING_DIACRITIC_MARKS_RE, '');
}

// After NFD, Arabic hamza/madda forms are a bare letter plus a mark, so
// dropping the marks (with tashkeel and tatweel) unifies أ/إ/آ/ا, ؤ/و, ئ/ي.
const ARABIC_FOLD_RE = /[\u0629\u0640\u0649\u064B-\u065F\u0660-\u0669\u0670\u0671\u06F0-\u06F9]/g;

export function foldArabicLetters(value: string): string {
  return value.replace(ARABIC_FOLD_RE, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x0629) return '\u0647'; // ة -> ه
    if (code === 0x0649) return '\u064A'; // ى -> ي
    if (code === 0x0671) return '\u0627'; // ٱ -> ا
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
    if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
    return '';
  });
}

export function splitLetterNumberTokens(value: string): string[] {
  return value.split(LETTER_NUMBER_SEPARATOR_RE).filter(Boolean);
}

export function splitLetterNumberPlusTokens(value: string): string[] {
  return value.split(LETTER_NUMBER_PLUS_SEPARATOR_RE).filter(Boolean);
}

export function isLetterOrNumber(value: string): boolean {
  return LETTER_OR_NUMBER_RE.test(value);
}

export function isLetterNumberWord(value: string): boolean {
  return LETTER_NUMBER_WORD_RE.test(value);
}

export function containsArabicOrHan(value: string): boolean {
  return ARABIC_OR_HAN_RE.test(value);
}
