import { isRtl } from '../navigation/reading-direction';

// A right-to-left scroller counts scrollLeft differently by engine: Chromium
// before 85 (webOS 4–6) runs it from max (start) down to 0, later Chromium
// from 0 (start) down to -max. These helpers speak in engine-neutral terms.
type RtlScrollModel = 'default' | 'negative';
let model: RtlScrollModel | null = null;

function rtlScrollModel(): RtlScrollModel {
  if (model) return model;
  const outer = document.createElement('div');
  outer.dir = 'rtl';
  outer.style.cssText = 'position:absolute;top:-1000px;width:4px;height:1px;overflow:scroll;visibility:hidden;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:8px;height:1px;';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  model = outer.scrollLeft > 0 ? 'default' : 'negative';
  document.body.removeChild(outer);
  return model;
}

function rtlScroller(el: HTMLElement): boolean {
  return isRtl() && getComputedStyle(el).direction === 'rtl';
}

// Physical position, 0 at the leftmost edge, for left/right edge logic.
export function physicalScrollLeft(el: HTMLElement): number {
  if (!rtlScroller(el) || rtlScrollModel() === 'default') return el.scrollLeft;
  return el.scrollLeft + el.scrollWidth - el.clientWidth;
}

export function setPhysicalScrollLeft(el: HTMLElement, value: number): void {
  if (!rtlScroller(el) || rtlScrollModel() === 'default') el.scrollLeft = value;
  else el.scrollLeft = value - (el.scrollWidth - el.clientWidth);
}

// Distance scrolled from the reading start, as virtualizers measure offsets.
export function inlineScrollStart(el: HTMLElement): number {
  if (!rtlScroller(el)) return el.scrollLeft;
  return el.scrollWidth - el.clientWidth - physicalScrollLeft(el);
}

export function setInlineScrollStart(el: HTMLElement, value: number): void {
  if (!rtlScroller(el)) el.scrollLeft = value;
  else setPhysicalScrollLeft(el, el.scrollWidth - el.clientWidth - value);
}

// The inline style side an absolutely placed cell offsets from.
export function inlineStartSide(): 'left' | 'right' {
  return isRtl() ? 'right' : 'left';
}

// For tests: re-measure the engine.
export function resetScrollModel(): void {
  model = null;
}
