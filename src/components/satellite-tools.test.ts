// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { revealDelta, SHARE_GUTTER_PX } from './satellite-tools';

describe('revealDelta', () => {
  const view = { top: 128, bottom: 1080 };

  // Measured on a TV: the share block ended exactly at the screen's bottom edge.
  it('leaves a gutter below a block that ends at the bottom edge', () => {
    const delta = revealDelta(view, { top: 791, bottom: 1080 }, SHARE_GUTTER_PX);
    expect(1080 - delta).toBeLessThanOrEqual(view.bottom - 32);
  });

  it('never scrolls the block top out of view', () => {
    expect(revealDelta(view, { top: 140, bottom: 1300 }, 40)).toBe(12);
  });

  it('leaves a block that already shows with its gutter alone', () => {
    expect(revealDelta(view, { top: 500, bottom: 1000 }, 40)).toBe(0);
  });
});
