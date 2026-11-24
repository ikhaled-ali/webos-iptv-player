// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyStylesheetDirection, stylesheetHref } from './stylesheet-direction';

describe('stylesheet direction', () => {
  it('maps app stylesheets to their mirrored copies and back', () => {
    expect(stylesheetHref('css/main.css', true)).toBe('css/rtl/main.css');
    expect(stylesheetHref('css/rtl/main.css', true)).toBe('css/rtl/main.css');
    expect(stylesheetHref('css/rtl/main.css', false)).toBe('css/main.css');
    expect(stylesheetHref('http://host/a.css', true)).toBe('http://host/a.css');
  });

  it('swaps every linked app stylesheet', () => {
    document.head.innerHTML = '<link rel="stylesheet" href="css/main.css"><link rel="stylesheet" href="css/tab-bar.css">';
    applyStylesheetDirection(true);
    expect(Array.from(document.querySelectorAll('link')).map(l => l.getAttribute('href')))
      .toEqual(['css/rtl/main.css', 'css/rtl/tab-bar.css']);
    applyStylesheetDirection(false);
    expect(Array.from(document.querySelectorAll('link')).map(l => l.getAttribute('href')))
      .toEqual(['css/main.css', 'css/tab-bar.css']);
  });
});
