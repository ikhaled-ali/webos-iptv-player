import {
  foldArabicLetters,
  isLetterOrNumber,
  LETTER_NUMBER_SEPARATOR_GLOBAL_RE,
  splitLetterNumberTokens,
  stripCombiningDiacritics,
} from './unicode-text';

// Arabic entries are written already folded (ه for ة, ي for ى, bare alef).
const SYNONYM_GROUPS = [
  ['sports', 'sport', 'footy', 'football', 'soccer', 'athletics',
    'رياضه', 'الرياضه', 'رياضيه', 'رياضي', 'كره', 'القدم'],
  ['kids', 'kid', 'children', 'child', 'cartoons', 'cartoon', 'animation', 'animated',
    'اطفال', 'الاطفال', 'كرتون', 'الكرتون'],
  ['news', 'headlines', 'current affairs', 'اخبار', 'الاخبار', 'اخباريه'],
  ['movies', 'movie', 'films', 'film', 'cinema', 'افلام', 'الافلام', 'فيلم', 'سينما'],
  ['music', 'songs', 'song', 'concerts', 'concert', 'موسيقي', 'الموسيقي', 'اغاني', 'الاغاني'],
  ['documentaries', 'documentary', 'docs', 'history', 'nature', 'وثائقي', 'وثائقيه', 'الوثائقيه'],
] as const;

const STOP_WORDS = new Set([
  'find', 'me', 'show', 'watch', 'for', 'please', 'channel', 'channels', 'program', 'programs',
  'ابحث', 'عن', 'اعرض', 'شغل', 'شاهد', 'من', 'فضلك', 'لو', 'سمحت',
  'قناه', 'قنوات', 'برنامج', 'برامج',
]);

function fold(value: string): string {
  return foldArabicLetters(stripCombiningDiacritics(value.normalize('NFD'))).toLowerCase();
}

function splitFolded(value: string): string[] {
  return splitLetterNumberTokens(value);
}

function tokens(value: string): string[] {
  return splitFolded(fold(value));
}

function queryTokens(query: string): string[] {
  const all = tokens(query);
  const meaningful = all.filter(token => !STOP_WORDS.has(token));
  return meaningful.length ? meaningful : all;
}

function variants(token: string): string[] {
  for (const group of SYNONYM_GROUPS) {
    if ((group as readonly string[]).includes(token)) return [token, ...group.filter(value => value !== token)];
  }
  return [token];
}

// Whether `a` and the token `value[start, end)` are at most one edit (or one
// adjacent swap) apart, compared by UTF-16 code unit.
function withinOneEdit(a: string, value: string, start: number, end: number): boolean {
  const bLength = end - start;
  if (Math.abs(a.length - bLength) > 1) return false;
  if (a.length === bLength) {
    let edits = 0;
    for (let i = 0; i < a.length;) {
      if (a.charCodeAt(i) === value.charCodeAt(start + i)) {
        i++;
        continue;
      }
      if (edits > 0) return false;
      edits++;
      if (i + 1 < a.length
          && a.charCodeAt(i) === value.charCodeAt(start + i + 1)
          && a.charCodeAt(i + 1) === value.charCodeAt(start + i)) i += 2;
      else i++;
    }
    return true;
  }

  const aShorter = a.length < bLength;
  const shorterLength = aShorter ? a.length : bLength;
  const longerLength = aShorter ? bLength : a.length;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorterLength && longIndex < longerLength) {
    const shortCode = aShorter ? a.charCodeAt(shortIndex) : value.charCodeAt(start + shortIndex);
    const longCode = aShorter ? value.charCodeAt(start + longIndex) : a.charCodeAt(longIndex);
    if (shortCode === longCode) {
      shortIndex++;
      longIndex++;
    } else {
      if (edits > 0) return false;
      edits++;
      longIndex++;
    }
  }
  return true;
}

// Best score of a query token's variants against the tokens of one field
// value, given as [start, end) pairs `bounds[from..to)` into `value`.
function tokenScore(
  expanded: readonly string[],
  value: string,
  bounds: Int32Array,
  from: number,
  to: number,
): number | null {
  let best: number | null = null;
  for (let variantIndex = 0; variantIndex < expanded.length; variantIndex++) {
    const variant = expanded[variantIndex];
    const length = variant.length;
    // First occurrence of `variant` at or after the current token's start;
    // -1 once none is left, so a field is scanned once per variant.
    let hit = -2;
    for (let pair = from; pair < to; pair += 2) {
      const start = bounds[pair];
      const end = bounds[pair + 1];
      const tokenLength = end - start;
      let score: number | null = null;
      if (length <= tokenLength && value.startsWith(variant, start)) {
        score = length === tokenLength
          ? (variantIndex === 0 ? 0 : 4)
          : (variantIndex === 0 ? 1 : 5);
      } else {
        if (hit !== -1 && hit < start) hit = value.indexOf(variant, start);
        if (hit !== -1 && hit + length <= end) score = variantIndex === 0 ? 2 : 6;
        else if (variantIndex === 0 && length >= 4 && withinOneEdit(variant, value, start, end)) score = 3;
      }
      if (score !== null && (best === null || score < best)) best = score;
    }
  }
  return best;
}

/**
 * A columnar search index. Item `i` owns the non-empty folded field values
 * `values[valueStart[i] .. valueStart[i + 1])`; value `v` owns the token
 * bounds `tokenBounds[tokenStart[v] .. tokenStart[v + 1])`, as [start, end)
 * pairs into that value, so no per-item objects or token strings are kept.
 */
export interface PreparedSearchIndex<T> {
  readonly length: number;
  readonly items: T[];
  readonly values: string[];
  readonly valueStart: Int32Array;
  readonly tokenStart: Int32Array;
  readonly tokenBounds: Int32Array;
}

export interface PreparedNameSearchIndex<T> {
  items: T[];
  values: string[];
}

export interface RankedSearchResult<T> {
  items: T[];
  hasMore: boolean;
}

interface ScoredSearchItem<T> {
  item: T;
  score: number;
  idx: number;
}

interface ScoredNameItem<T> {
  item: T;
  tier: number;
  pos: number;
  len: number;
  idx: number;
}

class IntList {
  private data: Int32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Int32Array(Math.max(16, capacity));
  }

  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }

  finish(): Int32Array {
    return this.length === this.data.length ? this.data : this.data.slice(0, this.length);
  }
}

export class SearchIndexBuilder<T> {
  private readonly items: T[] = [];
  private readonly values: string[] = [];
  private readonly valueStart: IntList;
  private readonly tokenStart: IntList;
  private readonly tokenBounds: IntList;

  constructor(expectedItems = 0) {
    this.valueStart = new IntList(expectedItems + 1);
    this.tokenStart = new IntList(expectedItems * 2 + 1);
    this.tokenBounds = new IntList(expectedItems * 8);
    this.valueStart.push(0);
    this.tokenStart.push(0);
  }

  /** Adds an item whose field values are already passed through `foldSearchText`. */
  add(item: T, folded: readonly string[]): void {
    this.items.push(item);
    for (let field = 0; field < folded.length; field++) {
      const value = folded[field];
      if (!value) continue;
      this.values.push(value);
      pushTokenBounds(value, this.tokenBounds);
      this.tokenStart.push(this.tokenBounds.length);
    }
    this.valueStart.push(this.values.length);
  }

  build(): PreparedSearchIndex<T> {
    return {
      length: this.items.length,
      items: this.items,
      values: this.values,
      valueStart: this.valueStart.finish(),
      tokenStart: this.tokenStart.finish(),
      tokenBounds: this.tokenBounds.finish(),
    };
  }
}

// The bounds of `splitFolded(value)`'s tokens: the non-empty runs between
// separator matches, exactly as `split(...).filter(Boolean)` yields them.
function pushTokenBounds(value: string, out: IntList): void {
  const separator = LETTER_NUMBER_SEPARATOR_GLOBAL_RE;
  separator.lastIndex = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(value)) !== null) {
    if (match.index > start) {
      out.push(start);
      out.push(match.index);
    }
    start = separator.lastIndex;
  }
  if (value.length > start) {
    out.push(start);
    out.push(value.length);
  }
}

export { fold as foldSearchText };

export function emptySearchIndex<T>(): PreparedSearchIndex<T> {
  return new SearchIndexBuilder<T>().build();
}

/** Indexes items whose field values are already passed through `foldSearchText`. */
export function prepareFoldedSearchItems<T>(
  items: readonly T[],
  folded: readonly (readonly string[])[],
): PreparedSearchIndex<T> {
  const builder = new SearchIndexBuilder<T>(items.length);
  for (let i = 0; i < items.length; i++) builder.add(items[i], folded[i]);
  return builder.build();
}

export function prepareSearchItems<T>(
  items: readonly T[],
  fields: (item: T) => string[],
): PreparedSearchIndex<T> {
  const builder = new SearchIndexBuilder<T>(items.length);
  for (let i = 0; i < items.length; i++) builder.add(items[i], fields(items[i]).map(fold));
  return builder.build();
}

export function prepareNameSearchItems<T extends { name: string }>(
  items: T[],
): PreparedNameSearchIndex<T> {
  return {
    items,
    values: items.map(item => fold(item.name)),
  };
}

function compareScored<T>(a: ScoredSearchItem<T>, b: ScoredSearchItem<T>): number {
  return a.score - b.score || a.idx - b.idx;
}

function compareNameScored<T>(a: ScoredNameItem<T>, b: ScoredNameItem<T>): number {
  return a.tier - b.tier
    || a.pos - b.pos
    || a.len - b.len
    || a.idx - b.idx;
}

function directScore<T>(
  index: PreparedSearchIndex<T>,
  item: number,
  query: string,
): number | null {
  let best: number | null = null;
  const first = index.valueStart[item];
  const last = index.valueStart[item + 1];
  for (let valueIndex = first; valueIndex < last; valueIndex++) {
    const value = index.values[valueIndex];
    const pos = value.indexOf(query);
    if (pos === -1) continue;
    const tier = value === query
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    const score = tier * 1000 + (valueIndex - first) * 100 + pos * 10 + value.length;
    if (best === null || score < best) best = score;
  }
  return best;
}

function fuzzyScore<T>(
  index: PreparedSearchIndex<T>,
  item: number,
  expandedTerms: readonly (readonly string[])[],
): number | null {
  let total = 10000;
  const first = index.valueStart[item];
  const last = index.valueStart[item + 1];
  for (let term = 0; term < expandedTerms.length; term++) {
    let best: number | null = null;
    for (let valueIndex = first; valueIndex < last; valueIndex++) {
      const score = tokenScore(
        expandedTerms[term],
        index.values[valueIndex],
        index.tokenBounds,
        index.tokenStart[valueIndex],
        index.tokenStart[valueIndex + 1],
      );
      if (score !== null) {
        const weighted = score + (valueIndex - first) * 10;
        if (best === null || weighted < best) best = weighted;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

class BoundedHeap<T> {
  private values: T[] = [];

  constructor(
    private limit: number,
    private compare: (a: T, b: T) => number,
  ) {}

  add(value: T): void {
    if (this.values.length < this.limit) {
      this.values.push(value);
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (this.compare(value, this.values[0]) >= 0) return;
    this.values[0] = value;
    this.bubbleDown(0);
  }

  sorted(): T[] {
    return this.values.sort(this.compare);
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], this.values[index]) >= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  private bubbleDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worse = index;
      if (left < this.values.length
          && this.compare(this.values[left], this.values[worse]) > 0) worse = left;
      if (right < this.values.length
          && this.compare(this.values[right], this.values[worse]) > 0) worse = right;
      if (worse === index) return;
      [this.values[index], this.values[worse]] = [this.values[worse], this.values[index]];
      index = worse;
    }
  }
}

/**
 * Ranks the index, or only the items at the positions in `subset` (ascending),
 * where ties break by position in `subset`.
 */
export function rankPreparedTopK<T>(
  index: PreparedSearchIndex<T>,
  query: string,
  limit: number,
  includeFuzzy = true,
  subset?: Int32Array,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  const terms = queryTokens(query);
  if (!q || !terms.length || limit <= 0) return { items: [], hasMore: false };
  const count = subset ? subset.length : index.length;
  const heap = new BoundedHeap<ScoredSearchItem<T>>(limit, compareScored);
  const directMatches = includeFuzzy ? new Uint8Array(count) : null;
  let matches = 0;
  for (let i = 0; i < count; i++) {
    const item = subset ? subset[i] : i;
    const score = directScore(index, item, q);
    if (score === null) continue;
    if (directMatches) directMatches[i] = 1;
    matches++;
    heap.add({ item: index.items[item], score, idx: i });
  }
  if (includeFuzzy && matches < limit) {
    const expandedTerms = terms.map(variants);
    for (let i = 0; i < count; i++) {
      if (directMatches?.[i]) continue;
      const item = subset ? subset[i] : i;
      const score = fuzzyScore(index, item, expandedTerms);
      if (score === null) continue;
      matches++;
      heap.add({ item: index.items[item], score, idx: i });
    }
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit
      || (includeFuzzy && matches >= limit && count > matches),
  };
}

export function rankPreparedNamesTopK<T>(
  index: PreparedNameSearchIndex<T>,
  query: string,
  limit: number,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  if (!q || limit <= 0) return { items: [], hasMore: false };
  const terms = tokens(query);
  const heap = new BoundedHeap<ScoredNameItem<T>>(limit, compareNameScored);
  let matches = 0;
  for (let i = 0; i < index.items.length; i++) {
    const value = index.values[i];
    let pos = value.indexOf(q);
    let tier: number;
    if (pos >= 0) {
      tier = value === q ? 0 : pos === 0 ? 1 : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    } else {
      if (!terms.length) continue;
      pos = Infinity;
      for (const term of terms) {
        const next = value.indexOf(term);
        if (next < 0) { pos = -1; break; }
        if (pos === Infinity) pos = next;
      }
      if (pos < 0) continue;
      tier = 4;
    }
    matches++;
    heap.add({
      item: index.items[i],
      tier,
      pos,
      len: value.length,
      idx: i,
    });
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit,
  };
}

export function rankPrepared<T>(index: PreparedSearchIndex<T>, query: string): T[] {
  return rankPreparedTopK(index, query, index.length).items;
}

export function rankByFields<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  return rankPrepared(prepareSearchItems(items, fields), query);
}

export function rankByName<T extends { name: string }>(items: T[], query: string): T[] {
  return rankPreparedNamesTopK(
    prepareNameSearchItems(items),
    query,
    items.length,
  ).items;
}

export function rankChannels<T extends { name: string; group: string; sourceName?: string }>(
  items: T[],
  query: string,
): T[] {
  // A renamed channel stays findable under its source name too.
  return rankByFields(items, query, item => [item.name, item.group, item.sourceName ?? '']);
}
