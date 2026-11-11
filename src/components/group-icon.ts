// Genre-icon matching for channel groups. Group titles are short, noisy and
// multilingual, so we normalize (lowercase + strip diacritics), tokenize on
// word boundaries (keeping non-Latin scripts intact), then match each rule's
// keywords against the title: an alphabetic word as a token PREFIX (catches
// plurals/inflections/translations and avoids substring false-positives like
// "sport" in "passport"); a phrase, symbol ("nat geo", "18+"), or CJK/Arabic
// keyword as a substring (CJK has no word boundaries; Arabic glues on "ال").
// Rules are in priority order — first match wins, so list specific genres
// first. Author keywords lowercase + accent-free (Latin) or in native script
// (non-Latin); adding a language is a one-line edit to GROUP_ICON_RULES below.
//
// Icons are flat inline outline SVGs drawn with `currentColor`, so they take
// the theme's accent from `.group-icon`.

import {
  containsArabicOrHan,
  isLetterNumberWord,
  splitLetterNumberPlusTokens,
  stripDiacritics,
} from '../utils/unicode-text';

interface IconRule {
  icon: string;
  keywords: string[];
}

interface Keyword {
  text: string;
  prefix: boolean;
}

const ADULT_ICON = 'no_one_under_eighteen';

const GROUP_ICON_RULES: IconRule[] = [
  {
    icon: 'teddy_bear',
    keywords: ['kid', 'child', 'cartoon', 'toon', 'infantil', 'junior', 'baby', 'babies', 'nick', 'disney', 'enfant', 'kinder', 'zeichentrick', 'kika', 'bambini', 'cocuk', 'nino', 'ninos', 'dibujos', 'caricatura', 'desenho', 'детск', 'дети', 'اطفال', '儿童', '少儿', '卡通', '动画', '动漫'],
  },
  {
    icon: 'soccer_ball',
    keywords: ['sport', 'spor', 'deport', 'esport', 'futbol', 'futebol', 'baloncesto', 'ciclismo', 'foot', 'football', 'soccer', 'calcio', 'fussball', 'fußball', 'bundesliga', 'voetbal', 'pilka', 'nba', 'nfl', 'nhl', 'mlb', 'ufc', 'boxing', 'boxe', 'golf', 'tennis', 'tenis', 'cricket', 'rugby', 'racing', 'motogp', 'formula', 'espn', 'bein', 'dazn', 'eurosport', 'спорт', 'футбол', 'رياض', '体育', '运动', '足球', '篮球'],
  },
  {
    icon: 'gaming',
    keywords: ['gaming', 'gamer', 'games', 'game', 'twitch', 'videojuego', 'juego', 'spiele', 'العاب', '游戏', '电竞'],
  },
  {
    icon: 'newspaper',
    keywords: ['news', 'notici', 'notizie', 'nachricht', 'actualit', 'haber', 'nieuws', 'wiadomosc', 'journal', 'breaking', 'cnn', 'bbc', 'msnbc', 'euronews', 'cnbc', 'aljazeera', 'новост', 'أخبار', 'al jazeera', 'sky news', 'fox news', '新闻', '资讯'],
  },
  {
    icon: 'musical_note',
    keywords: ['music', 'musica', 'musique', 'musik', 'muzyka', 'muzik', 'mtv', 'vevo', 'hits', 'radio', 'song', 'concert', 'concierto', 'konzert', 'karaoke', 'музык', 'موسيق', '音乐'],
  },
  {
    icon: 'cooking',
    keywords: ['cook', 'food', 'kitchen', 'recipe', 'chef', 'cocina', 'gastro', 'culinar', 'cuisine', 'kochen', 'طبخ', 'طعام', '美食', '烹饪', '料理'],
  },
  {
    icon: 'shopping',
    keywords: ['shop', 'teleshop', 'qvc', 'compra', 'tienda', 'einkauf', 'achat', 'تسوق', '购物'],
  },
  {
    icon: ADULT_ICON,
    keywords: ['adult', 'adulte', 'xxx', 'porn', 'erotic', 'erotik', 'взросл', 'yetiskin', 'erwachsen', 'brazzers', 'playboy', 'للكبار', 'بالغ', '+18', '18+', '21+', '成人'],
  },
  {
    icon: 'world_map',
    keywords: ['document', 'docu', 'dokument', 'discovery', 'histor', 'histoire', 'geschichte', 'science', 'cienc', 'wissen', 'nature', 'natur', 'tier', 'animal', 'planet', 'travel', 'viaje', 'voyage', 'reise', 'educa', 'wild', 'ocean', 'наук', 'документаль', 'истори', 'وثائق', 'nat geo', 'national geographic', 'bbc earth', '纪录', '探索', '自然', '历史', '科学', '地理'],
  },
  {
    icon: 'church',
    keywords: ['relig', 'church', 'gospel', 'islam', 'christ', 'cristian', 'quran', 'koran', 'bible', 'biblia', 'spiritual', 'catholic', 'catolic', 'iglesia', 'igreja', 'eglise', 'kirche', 'kilise', 'jesus', 'allah', 'mosque', 'mezquita', 'hindu', 'buddh', 'ислам', 'религ', 'православ', 'قرآن', 'ديني', 'اسلام', 'مسيحي', '宗教', '基督', '佛教', '伊斯兰'],
  },
  {
    icon: 'clapper_board',
    keywords: ['movie', 'film', 'cinema', 'cine', 'pelicula', 'kino', 'sinema', 'vod', 'افلام', 'فيلم', 'кино', 'фильм', '电影', '影院'],
  },
  {
    icon: 'television',
    keywords: ['series', 'serie', 'serial', 'show', 'shows', 'sitcom', 'episod', 'dizi', 'novela', 'сериал', 'مسلسل', '电视剧', '连续剧', '剧集'],
  },
  {
    icon: 'entertainment',
    keywords: ['entertain', 'entreten', 'unterhaltung', 'divertiss', 'variety', 'variedad', 'general', 'comedy', 'comedi', 'ترفيه', 'منوعات', '娱乐', '综艺'],
  },
];

// Normalize for matching: strip combining diacritics ("Fútbol" -> "futbol"),
// unify Arabic alef/hamza/teh-marbuta/alef-maksura variants (so "الأطفال"
// folds toward "اطفال"), and lowercase.
function fold(value: string): string {
  // Printable ASCII has nothing to fold but case; most catalog names are.
  if (/^[\x20-\x7e]*$/.test(value)) return value.toLowerCase();
  return stripDiacritics(value.normalize('NFD')) // accents + Arabic tashkeel/hamza/madda
    .replace(/[آأإٱ]/gu, 'ا')        // آأإٱ -> ا
    .replace(/ى/gu, 'ي')             // ى -> ي
    .replace(/ة/gu, 'ه')             // ة -> ه
    .toLowerCase();
}

// Split into word tokens on anything that isn't a letter, digit or '+'.
// Explicit ranges keep Latin/Cyrillic/Arabic/CJK letters intact; '+' preserves
// markers like "18+". Unicode punctuation and whitespace remain separators.
function tokenize(folded: string): string[] {
  return splitLetterNumberPlusTokens(folded);
}

// Fold and classify keywords once so rules can be authored with or without
// accents. Alphabetic words (Latin/Cyrillic...) match as a token prefix
// (catches inflections, avoids substring false-positives like "sport" in
// "passport"). Phrases ("nat geo"), symbols ("18+"), CJK and Arabic match as a
// substring: CJK has no word boundaries, and Arabic glues the definite
// article/clitics ("ال") onto the front of words.
const RULES: Array<{ icon: string; keywords: Keyword[] }> = GROUP_ICON_RULES.map(rule => ({
  icon: rule.icon,
  keywords: rule.keywords.map(fold).map(text => ({
    text,
    prefix: isLetterNumberWord(text) && !containsArabicOrHan(text),
  })),
}));

const ADULT_KEYWORDS = RULES.find(rule => rule.icon === ADULT_ICON)?.keywords ?? [];

function keywordHits(keyword: Keyword, folded: string, tokens: string[]): boolean {
  if (keyword.prefix) return tokens.some(token => token.startsWith(keyword.text));
  return folded.includes(keyword.text);
}

/**
 * Map a group title to an icon file name (without extension), or null
 * when nothing matches (the caller falls back to a generic glyph).
 */
export function matchGroupIcon(group: string): string | null {
  const folded = fold(group);
  const tokens = tokenize(folded);
  for (const rule of RULES) {
    if (rule.keywords.some(keyword => keywordHits(keyword, folded, tokens))) {
      return rule.icon;
    }
  }
  return null;
}

// Adult only, ignoring rule priority, so "Kids XXX" still counts.
export function isAdultGroupName(group: string): boolean {
  const folded = fold(group);
  const tokens = tokenize(folded);
  return ADULT_KEYWORDS.some(keyword => keywordHits(keyword, folded, tokens));
}

// One 24px grid, 1.8 stroke, round caps: a single family across categories.
const GROUP_ICON_PATHS: Record<string, string> = {
  all: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  three_oclock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  teddy_bear: '<circle cx="12" cy="13.5" r="6.5"/><path d="M7.4 8.9A2.5 2.5 0 1 1 10.3 7.2M13.7 7.2A2.5 2.5 0 1 1 16.6 8.9"/><ellipse cx="12" cy="16.2" rx="2.2" ry="1.6"/><circle cx="9.7" cy="12.4" r=".9" fill="currentColor" stroke="none"/><circle cx="14.3" cy="12.4" r=".9" fill="currentColor" stroke="none"/>',
  soccer_ball: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.6l3.2 2.3-1.2 3.8h-4l-1.2-3.8zM12 8.6V3.5M15.2 10.9l4.9-1.6M14 14.7l3 4.1M10 14.7l-3 4.1M8.8 10.9L3.9 9.3"/>',
  gaming: '<path d="M7.2 7.5h9.6a4.8 4.8 0 0 1 4.7 5.8l-.8 3.9a2.4 2.4 0 0 1-4.2 1L14.6 16H9.4l-1.9 2.2a2.4 2.4 0 0 1-4.2-1l-.8-3.9a4.8 4.8 0 0 1 4.7-5.8z"/><path d="M8 10.5v3.4M6.3 12.2h3.4"/><circle cx="15.6" cy="11" r=".9" fill="currentColor" stroke="none"/><circle cx="17.6" cy="13.2" r=".9" fill="currentColor" stroke="none"/>',
  newspaper: '<path d="M4 5.5h12.5V18a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2zM16.5 9.5H20V18a2 2 0 0 1-2 2"/><path d="M7 9h6.5M7 12.5h6.5M7 16h4"/>',
  musical_note: '<path d="M9 17.5V5.5l11-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>',
  cooking: '<path d="M7 17v-3.2a3.7 3.7 0 0 1 .6-7.3 4.8 4.8 0 0 1 8.8 0 3.7 3.7 0 0 1 .6 7.3V17zM7 20.5h10"/>',
  shopping: '<path d="M5 8h14l-1 12.5H6zM9 8V6.5a3 3 0 0 1 6 0V8"/>',
  no_one_under_eighteen: '<circle cx="12" cy="12" r="8.5"/><text x="12" y="14.6" font-size="7.4" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">18+</text>',
  world_map: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5"/><path d="M3.5 12h17"/>',
  church: '<path d="M12 2.5v4M10.3 4.2h3.4M7 20.5v-7.5l5-4 5 4v7.5M3.5 20.5h17M7 14.5l-3 1.6v4.4M17 14.5l3 1.6v4.4M10.5 20.5v-3a1.5 1.5 0 0 1 3 0v3"/>',
  clapper_board: '<path d="M4 10.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM3.7 7.2l15-3.2.7 3.3-15 3.2zM8.6 6.2l2.4 2.8M13.4 5.1l2.4 2.8"/>',
  television: '<rect x="2.5" y="6.5" width="19" height="13" rx="2"/><path d="M8 3l4 3.5L16 3"/>',
  entertainment: '<path d="M10.5 4l1.7 4.8L17 10.5l-4.8 1.7L10.5 17l-1.7-4.8L4 10.5l4.8-1.7zM18 14.5v5M15.5 17h5"/>',
  other: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.6v6.8l5.4-3.4z" fill="currentColor"/>',
};

function iconSvg(name: string): string {
  return `<svg class="group-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GROUP_ICON_PATHS[name] ?? GROUP_ICON_PATHS.other}</svg>`;
}

/**
 * Render the group-list icon as trusted SVG markup for the caller's `raw()`:
 * the matched genre, the All/Favorites/Recently watched icons, or a generic
 * play icon for unmatched groups.
 */
export function groupIcon(group: string, builtin?: 'all' | 'favorites' | 'recently-watched'): string {
  if (builtin === 'all') return iconSvg('all');
  if (builtin === 'favorites') return iconSvg('star');
  if (builtin === 'recently-watched') return iconSvg('three_oclock');
  return iconSvg(matchGroupIcon(group) ?? 'other');
}
