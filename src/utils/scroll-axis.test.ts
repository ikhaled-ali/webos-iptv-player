// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  inlineScrollStart,
  inlineStartSide,
  physicalScrollLeft,
  resetScrollModel,
  setInlineScrollStart,
  setPhysicalScrollLeft,
} from './scroll-axis';

// jsdom has no layout: a track 100px wide over 300px of content, whose
// scrollLeft follows the engine's model (`negative`: 0 at the start, -200 at
// the end; jsdom's probe measures 0, so it reads as that model).
function track(direction: 'ltr' | 'rtl'): HTMLElement & { raw: number } {
  const el = document.createElement('div') as HTMLElement & { raw: number };
  el.style.direction = direction;
  el.raw = 0;
  Object.defineProperty(el, 'scrollWidth', { value: 300 });
  Object.defineProperty(el, 'clientWidth', { value: 100 });
  Object.defineProperty(el, 'scrollLeft', {
    get: () => el.raw,
    set: (v: number) => { el.raw = v; },
  });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.documentElement.dir = '';
  document.body.innerHTML = '';
  resetScrollModel();
});

describe('scroll-axis', () => {
  it('passes left-to-right scrollers straight through', () => {
    const el = track('ltr');
    setInlineScrollStart(el, 40);
    expect(el.raw).toBe(40);
    expect(inlineScrollStart(el)).toBe(40);
    expect(physicalScrollLeft(el)).toBe(40);
    expect(inlineStartSide()).toBe('left');
  });

  it('maps a right-to-left scroller in the negative model', () => {
    document.documentElement.dir = 'rtl';
    const el = track('rtl');
    expect(inlineScrollStart(el)).toBe(0);
    expect(physicalScrollLeft(el)).toBe(200);
    setInlineScrollStart(el, 50);
    expect(el.raw).toBe(-50);
    setPhysicalScrollLeft(el, 0);
    expect(el.raw).toBe(-200);
    expect(inlineScrollStart(el)).toBe(200);
    expect(inlineStartSide()).toBe('right');
  });
});
