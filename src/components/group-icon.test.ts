import { describe, it, expect, vi } from 'vitest';
import { matchGroupIcon, groupIcon, isAdultGroupName } from './group-icon';

describe('matchGroupIcon', () => {
  describe('category matching', () => {
    it('maps each genre to its icon', () => {
      expect(matchGroupIcon('Kids')).toBe('teddy_bear');
      expect(matchGroupIcon('Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('Gaming')).toBe('gaming');
      expect(matchGroupIcon('News HD')).toBe('newspaper');
      expect(matchGroupIcon('Music')).toBe('musical_note');
      expect(matchGroupIcon('Cooking')).toBe('cooking');
      expect(matchGroupIcon('Shopping')).toBe('shopping');
      expect(matchGroupIcon('Adult')).toBe('no_one_under_eighteen');
      expect(matchGroupIcon('Documentaries')).toBe('world_map');
      expect(matchGroupIcon('Religion')).toBe('church');
      expect(matchGroupIcon('Movies')).toBe('clapper_board');
      expect(matchGroupIcon('Series')).toBe('television');
      expect(matchGroupIcon('Entertainment')).toBe('entertainment');
    });

    it('recognizes alias keywords', () => {
      expect(matchGroupIcon('Comedy')).toBe('entertainment');
      expect(matchGroupIcon('Food Network')).toBe('cooking');
    });
  });

  describe('normalization & matching rules', () => {
    it('ignores case and diacritics', () => {
      expect(matchGroupIcon('FÚTBOL')).toBe('soccer_ball');
      expect(matchGroupIcon('Notícias')).toBe('newspaper');
      expect(matchGroupIcon('Música')).toBe('musical_note');
      expect(matchGroupIcon('Niños')).toBe('teddy_bear');
    });

    it('strips IPTV prefixes, flags and quality tags', () => {
      expect(matchGroupIcon('FR| SPORT FHD')).toBe('soccer_ball');
      expect(matchGroupIcon('🇬🇧 UK | Kids')).toBe('teddy_bear');
      expect(matchGroupIcon('US: Music 4K')).toBe('musical_note');
    });

    it('uses token-prefix matching to avoid substring false-positives', () => {
      // "sport" is a substring of "passport" but not a token prefix.
      expect(matchGroupIcon('Passport Services')).toBeNull();
      expect(matchGroupIcon('αsports')).toBeNull();
    });

    it('splits tokens on Unicode punctuation and whitespace', () => {
      expect(matchGroupIcon('HD—Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('UK\u2003Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('Sports•News')).toBe('soccer_ball');
    });

    it('resolves overlaps by rule priority (first match wins)', () => {
      expect(matchGroupIcon('Kids Movies')).toBe('teddy_bear');            // kids before movies
      expect(matchGroupIcon('Adult Movies')).toBe('no_one_under_eighteen'); // adult before movies
    });

    it('matches +18 / 18+ markers as substrings', () => {
      expect(matchGroupIcon('Movies 18+')).toBe('no_one_under_eighteen');
      expect(matchGroupIcon('+18 VIP')).toBe('no_one_under_eighteen');
    });

    it('returns null for groups with no genre signal', () => {
      expect(matchGroupIcon('')).toBeNull();
      expect(matchGroupIcon('— •')).toBeNull();
      expect(matchGroupIcon('Uncategorized')).toBeNull();
      expect(matchGroupIcon('Random Channel 42')).toBeNull();
    });
  });

  describe('language coverage', () => {
    it('Spanish, incl. inflected forms', () => {
      expect(matchGroupIcon('Deportes')).toBe('soccer_ball');        // deport- stem
      expect(matchGroupIcon('Fútbol Deportivo')).toBe('soccer_ball');
      expect(matchGroupIcon('Noticiero 24h')).toBe('newspaper');     // notici- stem
      expect(matchGroupIcon('Películas')).toBe('clapper_board');
      expect(matchGroupIcon('Infantil')).toBe('teddy_bear');
      expect(matchGroupIcon('Documentales')).toBe('world_map');
      expect(matchGroupIcon('Cocina')).toBe('cooking');
      expect(matchGroupIcon('Música en Español')).toBe('musical_note');
    });

    it('German', () => {
      expect(matchGroupIcon('Nachrichten')).toBe('newspaper');
      expect(matchGroupIcon('Kinder')).toBe('teddy_bear');
      expect(matchGroupIcon('DE | Sport')).toBe('soccer_ball');
      expect(matchGroupIcon('Fußball Bundesliga')).toBe('soccer_ball');
      expect(matchGroupIcon('Dokumentation')).toBe('world_map');
      expect(matchGroupIcon('Geschichte & Wissen')).toBe('world_map');
      expect(matchGroupIcon('Kinofilme')).toBe('clapper_board');
      expect(matchGroupIcon('Unterhaltung')).toBe('entertainment');
    });

    it('Russian (Cyrillic)', () => {
      expect(matchGroupIcon('Спорт')).toBe('soccer_ball');
      expect(matchGroupIcon('Новости')).toBe('newspaper');
    });

    it('Simplified Chinese (substring — no word boundaries)', () => {
      expect(matchGroupIcon('体育频道')).toBe('soccer_ball');   // sports channel
      expect(matchGroupIcon('环球新闻')).toBe('newspaper');      // news mid-token
      expect(matchGroupIcon('电影')).toBe('clapper_board');      // movies
      expect(matchGroupIcon('电视剧')).toBe('television');       // series
      expect(matchGroupIcon('少儿频道')).toBe('teddy_bear');     // kids
      expect(matchGroupIcon('音乐')).toBe('musical_note');       // music
      expect(matchGroupIcon('购物')).toBe('shopping');           // shopping
      expect(matchGroupIcon('游戏')).toBe('gaming');             // gaming
      expect(matchGroupIcon('纪录片')).toBe('world_map');        // documentary
      expect(matchGroupIcon('娱乐')).toBe('entertainment');      // entertainment
    });

    it('Arabic, incl. the definite article (ال) and inflections', () => {
      expect(matchGroupIcon('رياضة')).toBe('soccer_ball');
      expect(matchGroupIcon('الرياضة')).toBe('soccer_ball');      // "the sports"
      expect(matchGroupIcon('الرِّيَاضَة')).toBe('soccer_ball');
      expect(matchGroupIcon('قنوات رياضية')).toBe('soccer_ball'); // adjective form
      expect(matchGroupIcon('الأخبار')).toBe('newspaper');        // the news
      expect(matchGroupIcon('أَخْبَار')).toBe('newspaper');
      expect(matchGroupIcon('قناة الأطفال')).toBe('teddy_bear');  // kids channel
      expect(matchGroupIcon('أفلام')).toBe('clapper_board');      // movies
      expect(matchGroupIcon('مسلسلات')).toBe('television');       // series
      expect(matchGroupIcon('ألعاب')).toBe('gaming');             // games
      expect(matchGroupIcon('تسوق')).toBe('shopping');            // shopping
      expect(matchGroupIcon('ترفيه')).toBe('entertainment');      // entertainment
    });
  });
});

describe('groupIcon (rendered HTML)', () => {
  it('renders a matched genre as an inline currentColor SVG', () => {
    const svg = groupIcon('Sports');
    expect(svg).toMatch(/^<svg class="group-logo" viewBox="0 0 24 24"[^>]* stroke="currentColor"/);
    expect(svg).not.toContain('<img');
  });

  it('draws a distinct icon per genre and builtin', () => {
    const icons = ['Sports', 'News', 'Kids', 'Music', 'Movies']
      .map((g) => groupIcon(g))
      .concat(groupIcon('All', 'all'), groupIcon('Favorites', 'favorites'),
        groupIcon('Recent', 'recently-watched'));
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('falls back to a generic SVG for unmatched groups', () => {
    const svg = groupIcon('Uncategorized');
    expect(svg).toMatch(/^<svg class="group-logo"/);
    expect(svg).not.toBe(groupIcon('Sports'));
  });
});
