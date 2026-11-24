// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readingOrderAction, screenSide } from './reading-direction';

afterEach(() => { document.documentElement.dir = ''; });

describe('reading-direction', () => {
  it('keeps Left/Right as they are left-to-right', () => {
    expect(readingOrderAction('left')).toBe('left');
    expect(screenSide('right')).toBe('right');
  });

  it('swaps Left/Right into reading order right-to-left, and back', () => {
    document.documentElement.dir = 'rtl';
    expect(readingOrderAction('left')).toBe('right');
    expect(readingOrderAction('right')).toBe('left');
    expect(readingOrderAction('up')).toBe('up');
    expect(screenSide(readingOrderAction('left'))).toBe('left');
  });
});
