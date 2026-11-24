import { createLogger } from './logger';
import { Focus } from '../navigation/focus-scope';
import { isRtl } from '../navigation/reading-direction';

const log = createLogger('Dom');

export function $(selector: string, parent: Element | Document = document): HTMLElement | null {
  return parent.querySelector(selector);
}

export function $$(selector: string, parent: Element | Document = document): HTMLElement[] {
  return Array.from(parent.querySelectorAll(selector));
}

// A shown or hidden view flips the base and every `when` that reads
// `inShownView`, with no input or morph to settle the owner; the pass
// runs once the whole switch is done.
export function show(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = '';
  el.classList.remove('hidden');
  Focus.reconcile();
}

export function hide(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = 'none';
  el.classList.add('hidden');
  Focus.reconcile();
}

/** Whether `el` sits in the shown view, or outside every view. */
export function inShownView(el: Element): boolean {
  const view = el.closest('.view');
  return !view || !view.classList.contains('hidden');
}

// --- Transition end ------------------------------------------------------
// `addEventListener(…, { once: true })` is Chrome 55+; Chromium 53 ignores
// `once` and keeps the listener, so remove it by hand.
// Returns a function that stops waiting.
export function onceTransitionEnd(el: HTMLElement, callback: () => void): () => void {
  const onEnd = (): void => {
    el.removeEventListener('transitionend', onEnd);
    callback();
  };
  el.addEventListener('transitionend', onEnd);
  return () => el.removeEventListener('transitionend', onEnd);
}

// --- Focus without scrolling ---------------------------------------------
// `focus({ preventScroll })` is Chrome 64+; Chromium 53 ignores the option and
// scrolls the target into view. Detect once whether the engine reads it, and
// otherwise restore every ancestor's scroll offset after a plain focus.

let preventScrollSupported: boolean | undefined;

function supportsPreventScroll(): boolean {
  if (preventScrollSupported !== undefined) return preventScrollSupported;
  let read = false;
  const probe = {};
  Object.defineProperty(probe, 'preventScroll', {
    get: () => { read = true; return true; },
  });
  document.createElement('div').focus(probe);
  preventScrollSupported = read;
  log.info(
    'Focus option detected',
    'event=compat.focus.preventScroll',
    `supported=${read ? 1 : 0}`,
  );
  return read;
}

// The strip at the top of a scroller that sits under the frosted tab bar,
// declared as its scroll-padding-top (0 where content stops below the bar).
export function scrollInsetTop(el: Element): number {
  const inset = parseFloat(getComputedStyle(el).getPropertyValue('scroll-padding-top'));
  return isFinite(inset) ? inset : 0;
}

// A scroller's height below the bar: the part that can show a focused row.
export function visibleHeight(el: HTMLElement): number {
  return el.clientHeight - scrollInsetTop(el);
}

export function focusWithoutScroll(el: HTMLElement): void {
  if (supportsPreventScroll()) {
    el.focus({ preventScroll: true });
    return;
  }
  const offsets: { node: Element; top: number; left: number }[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    offsets.push({ node, top: node.scrollTop, left: node.scrollLeft });
  }
  el.focus();
  for (const { node, top, left } of offsets) {
    if (node.scrollTop !== top) node.scrollTop = top;
    if (node.scrollLeft !== left) node.scrollLeft = left;
  }
}

// Overrides the CSS smooth-scroll policy for one synchronous scroll. Goes
// through setProperty, which works whether or not the engine reflects
// `style.scrollBehavior`.
export function withInstantScroll(nodes: HTMLElement[], scroll: () => void): void {
  const saved = nodes.map((node) => node.style.getPropertyValue('scroll-behavior'));
  nodes.forEach((node) => node.style.setProperty('scroll-behavior', 'auto'));
  try {
    scroll();
  } finally {
    nodes.forEach((node, i) => node.style.setProperty('scroll-behavior', saved[i]));
  }
}

// --- Safe HTML templating ------------------------------------------------
// Channel names, programme titles, logo URLs etc. come from untrusted M3U /
// XMLTV sources. Interpolating them straight into innerHTML is a DOM-XSS hole,
// so render templates use the `html` tagged template, which HTML-escapes every
// interpolated value by default. Wrap intentional, trusted markup in `raw()`.

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/** A string that is already trusted HTML and must not be re-escaped. */
export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as trusted HTML so `html` won't escape it. */
export function raw(value: string): Safe {
  return new Safe(value);
}

function esc(value: unknown): string {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(esc).join('');
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Tagged template that escapes interpolated values. Nested `html` results and
 * `raw(...)` values pass through unescaped; arrays are escaped element-wise and
 * concatenated. Returns a `Safe` — call `String(...)` when assigning to innerHTML.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  const rtl = isRtl();
  let inTag = false;
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (rtl) {
      const open = strings[i].lastIndexOf('<');
      const close = strings[i].lastIndexOf('>');
      if (open !== close) inTag = open > close;
    }
    if (i < values.length) {
      const value = values[i];
      out += rtl && !inTag && typeof value === 'string' ? isolateLtr(esc(value)) : esc(value);
    }
  }
  return new Safe(out);
}

// In a right-to-left UI a Latin name such as "Alpha (HD)" would render as
// "(Alpha (HD" — its trailing punctuation takes the paragraph's direction.
// First-strong isolates (FSI…PDI) give interpolated text its own direction
// while the row keeps its right-to-left alignment. Attribute values are left
// alone.
const LTR_LETTER_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

function isolateLtr(text: string): string {
  return LTR_LETTER_RE.test(text) ? `\u2068${text}\u2069` : text;
}
