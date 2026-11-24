// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpatialNav, isFocusMove, type SpatialNavOptions } from './spatial-nav';
import { Focus, type FocusScope } from './focus-scope';
import { applyAnimationMode } from '../services/motion-service';
import { morph } from '../utils/morph';
import { html } from '../utils/dom';

// jsdom implements no layout: scrollIntoView is missing and getBoundingClientRect
// returns zeros. Stub both so focus()/move() can be exercised deterministically.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  applyAnimationMode('reduced');
});

afterEach(() => {
  Focus.setBase(() => null);
  Focus.uninstall();
});

function focusable(rect: { x: number; y: number; w?: number; h?: number }, container?: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-focusable', '');
  if (container) el.setAttribute('data-nav-container', container);
  const { x, y, w = 100, h = 40 } = rect;
  el.getBoundingClientRect = () =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect;
  return el;
}

function makeContainer(...els: HTMLElement[]): HTMLElement {
  const container = document.createElement('div');
  els.forEach((el) => container.appendChild(el));
  document.body.appendChild(container);
  return container;
}

// A nav whose focus scope owns the keys and paints its ring by `data-key`.
function bound(container: HTMLElement, options: SpatialNavOptions = {}): { nav: SpatialNav; scope: FocusScope } {
  Array.from(container.querySelectorAll<HTMLElement>('[data-focusable]')).forEach((el, i) => {
    if (el.dataset.key === undefined) el.dataset.key = `k${i}`;
  });
  let nav: SpatialNav | null = null;
  const scope = Focus.register({
    id: 'nav.test',
    root: container,
    defaultKey: () => nav?.focused?.dataset.key ?? null,
  });
  Focus.setBase(() => scope);
  nav = new SpatialNav(container, undefined, { ...options, scope });
  return { nav, scope };
}

function ringed(el: Element): boolean {
  Focus.flush();
  return el.classList.contains('focused');
}

describe('SpatialNav', () => {
  describe('focus', () => {
    it('has its scope ring the focused element and move the ring off the previous one', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav, scope } = bound(makeContainer(a, b));

      nav.focus(a);
      expect(ringed(a)).toBe(true);
      expect(nav.focused).toBe(a);
      expect(scope.focusKey).toBe(a.dataset.key);

      nav.focus(b);
      expect(ringed(a)).toBe(false);
      expect(ringed(b)).toBe(true);
      expect(nav.focused).toBe(b);
    });

    it('never paints a ring itself', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const container = makeContainer(a, b);
      const nav = new SpatialNav(container);
      nav.focus(a);
      nav.move('down');
      expect(nav.focused).toBe(b);
      expect(container.querySelector('.focused')).toBeNull();
    });

    it('tells a host every request, the focused element\'s own included, and how it came', () => {
      const a = focusable({ x: 0, y: 0 });
      const requests: [HTMLElement | null, string][] = [];
      const nav = new SpatialNav(makeContainer(a), undefined, {
        onRequest: (el, via) => requests.push([el, via]),
      });
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      nav.focus(null);
      expect(requests).toEqual([[a, 'key'], [a, 'pointer'], [null, 'key']]);
    });

    it('only picks, without following the pointer or scrolling, when the view follows it', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const picked: (HTMLElement | null)[] = [];
      const container = makeContainer(a, b);
      const nav = new SpatialNav(container, (el) => picked.push(el), { follow: false });

      nav.focus(a);
      expect(nav.move('down')).toBe(true);
      nav.focus(b);
      b.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

      expect(nav.focused).toBe(b);
      // Re-asking for the focused element still reaches the scope.
      expect(picked).toEqual([a, b, b]);
      expect(container.querySelector('.focused')).toBeNull();
      expect(b.scrollIntoView).not.toHaveBeenCalled();
    });

    it('reports a re-hover of the focused element to a view that mirrors focus', () => {
      const a = focusable({ x: 0, y: 0 });
      const picked: (HTMLElement | null)[] = [];
      const nav = new SpatialNav(makeContainer(a), (el) => picked.push(el));

      nav.focus(a);
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

      // A same-element key request changes nothing; a re-hover may relight.
      expect(picked).toEqual([a, a]);
      expect(a.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('leaves isolated focus scrolling to CSS', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focus(a);
      nav.focus(b);
      expect(b.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'auto' }),
      );
    });

    it('forces only repeated focus changes to scroll instantly', () => {
      applyAnimationMode('full');
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValueOnce(1000)
        .mockReturnValueOnce(1080)
        .mockReturnValueOnce(1300);
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const c = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(a, b, c));

      nav.focus(a);
      nav.focus(b);
      nav.focus(c);

      expect(a.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'auto' }),
      );
      expect(b.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'instant' }),
      );
      expect(c.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'auto' }),
      );
      now.mockRestore();
    });

    it('skips scrollIntoView when re-focusing the already-focused element', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      expect(a.scrollIntoView).toHaveBeenCalledTimes(1);
      nav.focus(a); // e.g. mouseover sweeping across the row's children
      expect(a.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('re-asserts the ring on the same element (morph may strip it)', () => {
      const a = focusable({ x: 0, y: 0 });
      const { nav } = bound(makeContainer(a));
      nav.focus(a);
      expect(ringed(a)).toBe(true);
      a.classList.remove('focused'); // morph treats class as authoritative
      nav.focus(a);
      expect(ringed(a)).toBe(true);
    });

    it('a pointer leaving conceals the ring but keeps focus, and returning shows it', () => {
      const a = focusable({ x: 0, y: 0 });
      const { nav, scope } = bound(makeContainer(a));
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      expect(ringed(a)).toBe(false);
      expect(scope.concealed).toBe(true);
      expect(nav.focused).toBe(a); // kept for d-pad/hover resume
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(ringed(a)).toBe(true);
    });

    it('focus(null) clears the current focus', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      nav.focus(null);
      expect(a.classList.contains('focused')).toBe(false);
      expect(nav.focused).toBeNull();
    });

    it('focusFirst focuses the first focusable element', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focusFirst();
      expect(nav.focused).toBe(a);
    });

    it('focusBySelector focuses a matching element', () => {
      const a = focusable({ x: 0, y: 0 });
      a.id = 'target';
      const nav = new SpatialNav(makeContainer(a));
      nav.focusBySelector('#target');
      expect(nav.focused).toBe(a);
    });

    it('focusContainerEntry enters at the first item and restores the last item', () => {
      const outside = focusable({ x: 0, y: 0 });
      const list = document.createElement('div');
      list.className = 'list';
      list.setAttribute('data-nav-container', '');
      const first = focusable({ x: 200, y: 0 });
      const second = focusable({ x: 200, y: 100 });
      list.append(first, second);
      const nav = new SpatialNav(makeContainer(outside, list));

      expect(nav.focusContainerEntry('.list')).toBe(true);
      expect(nav.focused).toBe(first);
      nav.focus(second);
      nav.focus(outside);
      expect(nav.focusContainerEntry('.list')).toBe(true);
      expect(nav.focused).toBe(second);
    });
  });

  describe('nav:hover', () => {
    it('focuses a focusable element when it receives nav:hover', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(nav.focused).toBe(a);
    });

    it('conceals only the ring when the pointer leaves', () => {
      const a = focusable({ x: 0, y: 0 });
      const { nav } = bound(makeContainer(a));
      nav.focus(a);
      expect(ringed(a)).toBe(true);

      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      expect(ringed(a)).toBe(false);
      expect(nav.focused).toBe(a);
    });

    it('leaves the ring alone when the pointer leaves an element focus moved off', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav, scope } = bound(makeContainer(a, b));
      nav.focus(a);
      nav.focus(b);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      expect(scope.concealed).toBe(false);
      expect(ringed(b)).toBe(true);
    });
  });

  describe('move', () => {
    it('focuses the first element when nothing is focused yet', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.move('down');
      expect(nav.focused).toBe(a);
    });

    it('moves down to the geometrically nearest element below', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(top);
      nav.move('down');
      expect(nav.focused).toBe(bottom);
    });

    it('moves up to the element above', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(bottom);
      nav.move('up');
      expect(nav.focused).toBe(top);
    });

    it('moves right to the element to the right', () => {
      const left = focusable({ x: 0, y: 0 });
      const right = focusable({ x: 200, y: 0 });
      const nav = new SpatialNav(makeContainer(left, right));
      nav.focus(left);
      nav.move('right');
      expect(nav.focused).toBe(right);
    });

    it('stops Right at the end of its row instead of running on to the next row', () => {
      const first = focusable({ x: 0, y: 0 });
      const last = focusable({ x: 200, y: 0 });
      const lowerRight = focusable({ x: 400, y: 100 });
      const nav = new SpatialNav(makeContainer(first, last, lowerRight));
      nav.focus(first);
      nav.move('right');
      expect(nav.focused).toBe(last);
      expect(nav.move('right')).toBe(false);
      expect(nav.focused).toBe(last);
    });

    it('does not move when there is no candidate in that direction', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(top);
      nav.move('up'); // nothing above the top element
      expect(nav.focused).toBe(top);
    });

    it('prefers the nearer of two candidates in the same direction', () => {
      const cur = focusable({ x: 0, y: 0 });
      const near = focusable({ x: 0, y: 100 });
      const far = focusable({ x: 0, y: 400 });
      const nav = new SpatialNav(makeContainer(cur, near, far));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(near);
    });

    // Rects are explicit here because jsdom has no layout; a stylesheet-hidden
    // element is proven in e2e/settings.spec.ts and e2e/movies.spec.ts.
    it('ignores zero-sized elements', () => {
      const cur = focusable({ x: 0, y: 0 });
      const collapsed = focusable({ x: 0, y: 100, w: 0, h: 0 });
      const visible = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(cur, collapsed, visible));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(visible);
    });

    it('ignores elements hidden with visibility', () => {
      const cur = focusable({ x: 0, y: 0 });
      const invisible = focusable({ x: 0, y: 100 });
      invisible.classList.add('stylesheet-hidden');
      const style = document.createElement('style');
      style.textContent = '.stylesheet-hidden { visibility: hidden; }';
      document.head.appendChild(style);
      const visible = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(cur, invisible, visible));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(visible);
      style.remove();
    });

    it('reuses computed visibility while only focus classes change', async () => {
      const cur = focusable({ x: 0, y: 0 });
      const next = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(cur, next));
      const computedStyle = vi.spyOn(window, 'getComputedStyle');

      nav.focus(cur);
      nav.move('down');
      await Promise.resolve();
      const calls = computedStyle.mock.calls.length;
      nav.move('up');

      expect(computedStyle).toHaveBeenCalledTimes(calls);
      computedStyle.mockRestore();
    });

    it('invalidates cached visibility when a stylesheet changes', async () => {
      const cur = focusable({ x: 0, y: 0 });
      const hidden = focusable({ x: 0, y: 100 });
      hidden.setAttribute('data-runtime-hidden', '');
      const visible = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(cur, hidden, visible));

      nav.focus(cur);
      nav.move('down');
      nav.move('up');
      const style = document.createElement('style');
      style.textContent = '[data-runtime-hidden] { visibility: hidden; }';
      document.head.appendChild(style);
      await Promise.resolve();
      nav.move('down');

      expect(nav.focused).toBe(visible);
      style.remove();
    });

    it('does not measure unrelated containers for a nearby move', () => {
      const left = document.createElement('div');
      left.setAttribute('data-nav-container', '');
      const cur = focusable({ x: 0, y: 0 });
      const next = focusable({ x: 0, y: 100 });
      left.append(cur, next);
      const right = document.createElement('div');
      right.setAttribute('data-nav-container', '');
      const unrelated = focusable({ x: 200, y: 0 });
      const unrelatedRect = vi.spyOn(unrelated, 'getBoundingClientRect');
      right.appendChild(unrelated);
      const nav = new SpatialNav(makeContainer(left, right));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(next);
      expect(unrelatedRect).not.toHaveBeenCalled();
    });

    it('scans other containers when their penalty can be beaten', () => {
      const left = document.createElement('div');
      left.setAttribute('data-nav-container', '');
      const cur = focusable({ x: 0, y: 0 });
      const far = focusable({ x: 0, y: 6000 });
      left.append(cur, far);
      const right = document.createElement('div');
      right.setAttribute('data-nav-container', '');
      const across = focusable({ x: 200, y: 100 });
      right.appendChild(across);
      const nav = new SpatialNav(makeContainer(left, right));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(across);
    });

    // focusFirst takes DOM order, not geometry, so a hidden leading element is
    // picked outright — no scoring to save it.
    it('focusFirst skips a hidden leading element', () => {
      const collapsed = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const visible = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(collapsed, visible));
      nav.focusFirst();
      expect(nav.focused).toBe(visible);
    });

    it('first names where focusFirst would land without moving focus', () => {
      const collapsed = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const visible = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(collapsed, visible));
      expect(nav.first()).toBe(visible);
      expect(nav.focused).toBeNull();
    });

    // A view seeded with focus before it is shown measures zero everywhere;
    // filtering all of it out would leave focus nowhere.
    it('falls back to unmeasured elements when nothing has been laid out', () => {
      const a = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const b = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focusFirst();
      expect(nav.focused).toBe(a);
    });
  });

  describe('setRestrict', () => {
    function makeRestricted(): {
      nav: SpatialNav; outside: HTMLElement; inside: HTMLElement; dialog: HTMLElement;
    } {
      const outside = focusable({ x: 0, y: 0 });
      const dialog = document.createElement('div');
      const inside = focusable({ x: 0, y: 100 });
      const other = focusable({ x: 0, y: 200 });
      dialog.appendChild(inside);
      dialog.appendChild(other);
      const container = makeContainer(outside, dialog);
      return { nav: new SpatialNav(container), outside, inside, dialog };
    }

    it('keeps d-pad inside the restricted subtree', () => {
      const { nav, inside, dialog } = makeRestricted();
      nav.focus(inside);
      nav.setRestrict(dialog);
      expect(nav.move('up')).toBe(false); // the element above is outside
      expect(nav.focused).toBe(inside);
    });

    // One keypress is one step: entering the trap must land on its first
    // element, not enter and then move off it.
    it('enters at the first element when focus was outside', () => {
      const { nav, outside, inside, dialog } = makeRestricted();
      nav.focus(outside);
      nav.setRestrict(dialog);
      expect(nav.focused).toBe(outside);
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(inside);
    });

    it('releases the trap on null', () => {
      const { nav, outside, inside, dialog } = makeRestricted();
      nav.focus(inside);
      nav.setRestrict(dialog);
      nav.setRestrict(null);
      expect(nav.move('up')).toBe(true);
      expect(nav.focused).toBe(outside);
    });
  });

  describe('data-nav-enter="last-focused"', () => {
    function makeTwoContainers(enterTo?: string): {
      nav: SpatialNav; sidebarTop: HTMLElement; listTop: HTMLElement; listBottom: HTMLElement;
    } {
      const sidebar = document.createElement('div');
      sidebar.setAttribute('data-nav-container', '');
      const sidebarTop = focusable({ x: 0, y: 0 });
      const sidebarBottom = focusable({ x: 0, y: 100 });
      sidebar.appendChild(sidebarTop);
      sidebar.appendChild(sidebarBottom);

      const list = document.createElement('div');
      list.setAttribute('data-nav-container', '');
      if (enterTo) list.setAttribute('data-nav-enter', enterTo);
      const listTop = focusable({ x: 200, y: 0 });
      const listBottom = focusable({ x: 200, y: 100 });
      list.appendChild(listTop);
      list.appendChild(listBottom);

      const container = makeContainer(sidebar, list);
      return { nav: new SpatialNav(container), sidebarTop, listTop, listBottom };
    }

    it('returns to the last focused element when re-entering', () => {
      const { nav, sidebarTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listBottom); // not the geometrically nearest listTop
    });

    it('uses geometry for a container that has not been visited', () => {
      const { nav, sidebarTop, listTop } = makeTwoContainers('last-focused');
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });

    it('does not apply while moving within the same container', () => {
      const { nav, listTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(listTop);
      nav.move('down');
      expect(nav.focused).toBe(listBottom);
    });

    it('stays geometric without the opt-in attribute', () => {
      const { nav, sidebarTop, listTop, listBottom } = makeTwoContainers();
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });

    it('falls back to geometry when the remembered element is gone', () => {
      const { nav, sidebarTop, listTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      listBottom.remove();
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });
  });

  describe('setRestrict with focus left outside', () => {
    it('enters the trap at its first item even when another item is nearer', () => {
      const outside = focusable({ x: 0, y: 300 });
      const menu = document.createElement('div');
      const first = focusable({ x: 200, y: 0 });
      const near = focusable({ x: 200, y: 300 });
      menu.append(first, near);
      const nav = new SpatialNav(makeContainer(outside, menu));
      nav.setRestrict(menu);
      nav.focus(outside);

      nav.move('down');
      expect(nav.focused).toBe(first);
    });
  });

  describe('after the pointer leaves', () => {
    it('shows the kept focus on the first key instead of moving past it', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav } = bound(makeContainer(a, b));
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      expect(ringed(a)).toBe(false);

      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(a);
      expect(ringed(a)).toBe(true);
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(b);
      expect(ringed(b)).toBe(true);
    });

    it('moves on the first key when a re-render only stripped the class', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav } = bound(makeContainer(a, b));
      nav.focus(a);
      a.classList.remove('focused');

      nav.move('down');
      expect(nav.focused).toBe(b);
    });

    it('moves on the first key once hover has refocused an element', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const c = focusable({ x: 0, y: 200 });
      const { nav } = bound(makeContainer(a, b, c));
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      b.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

      nav.move('down');
      expect(nav.focused).toBe(c);
    });
  });

  describe('when the focused element is re-rendered away', () => {
    it('moves on from the element that took its data-key', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const c = focusable({ x: 0, y: 200 });
      b.dataset.key = 'row-b';
      const container = makeContainer(a, b, c);
      const nav = new SpatialNav(container);
      nav.focus(b);
      const replacement = focusable({ x: 0, y: 100 });
      replacement.dataset.key = 'row-b';
      container.replaceChild(replacement, b);

      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(c);
    });

    it('stays on the element that took its data-key at an edge', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      b.dataset.key = 'row-b';
      const container = makeContainer(a, b);
      const nav = new SpatialNav(container);
      nav.focus(b);
      const replacement = focusable({ x: 0, y: 100 });
      replacement.dataset.key = 'row-b';
      container.replaceChild(replacement, b);

      expect(nav.move('down')).toBe(false);
      expect(nav.focused).toBe(replacement);
    });

    it('shows a concealed ring on its keyed replacement before moving', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const c = focusable({ x: 0, y: 200 });
      b.dataset.key = 'row-b';
      const container = makeContainer(a, b, c);
      const { nav } = bound(container);
      nav.focus(b);
      b.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      const replacement = focusable({ x: 0, y: 100 });
      replacement.dataset.key = 'row-b';
      container.replaceChild(replacement, b);
      expect(ringed(replacement)).toBe(false);

      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(replacement);
      expect(ringed(replacement)).toBe(true);
    });

    it('recovers nearest where focus was instead of at the top', () => {
      const rows = [0, 100, 200, 300].map((y) => focusable({ x: 0, y }));
      const container = makeContainer(...rows);
      const nav = new SpatialNav(container);
      nav.focus(rows[2]);
      container.removeChild(rows[2]);

      expect(nav.move('down')).toBe(true);
      expect([rows[1], rows[3]]).toContain(nav.focused);
    });

    it('tells the host once when it adopts the keyed replacement', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      b.dataset.key = 'row-b';
      const container = makeContainer(a, b);
      const changes: (HTMLElement | null)[] = [];
      const nav = new SpatialNav(container, (el) => changes.push(el));
      nav.focus(b);
      const replacement = focusable({ x: 0, y: 100 });
      replacement.dataset.key = 'row-b';
      container.replaceChild(replacement, b);

      expect(nav.move('down')).toBe(false);
      expect(nav.move('down')).toBe(false);
      expect(changes).toEqual([b, replacement]);
    });

    it('returns to the adopted replacement when entering its container again', () => {
      const list = document.createElement('div');
      list.setAttribute('data-nav-container', 'list');
      list.setAttribute('data-nav-enter', 'last-focused');
      const a1 = focusable({ x: 0, y: 0 });
      const a2 = focusable({ x: 0, y: 100 });
      a2.dataset.key = 'row-2';
      list.append(a1, a2);
      const side = focusable({ x: 200, y: 0 }, 'side');
      const nav = new SpatialNav(makeContainer(list, side));
      nav.focus(a2);
      const replacement = focusable({ x: 0, y: 100 });
      replacement.dataset.key = 'row-2';
      list.replaceChild(replacement, a2);

      nav.move('right');
      expect(nav.focused).toBe(side);
      nav.move('left');
      expect(nav.focused).toBe(replacement);
    });

    it('adopts the same-key element in the lost element\'s container, not an earlier one', () => {
      const tiles = document.createElement('div');
      tiles.setAttribute('data-nav-container', 'tiles');
      const tile = focusable({ x: 0, y: 60 });
      tile.dataset.key = 'ch:1';
      tiles.append(tile);
      const rows = document.createElement('div');
      rows.setAttribute('data-nav-container', 'rows');
      const row = focusable({ x: 0, y: 100 });
      row.dataset.key = 'ch:1';
      const below = focusable({ x: 0, y: 200 });
      rows.append(row, below);
      const nav = new SpatialNav(makeContainer(tiles, rows));
      nav.focus(row);
      // The re-render shifted the row further than the tile sits from it.
      const replacement = focusable({ x: 0, y: 150 });
      replacement.dataset.key = 'ch:1';
      rows.replaceChild(replacement, row);

      expect(nav.move('right')).toBe(false);
      expect(nav.focused).toBe(replacement);
    });

    it('adopts the nearest same-key element once its container is gone too', () => {
      const tiles = document.createElement('div');
      tiles.setAttribute('data-nav-container', 'tiles');
      const tile = focusable({ x: 0, y: 0 });
      tile.dataset.key = 'ch:1';
      tiles.append(tile);
      const rows = document.createElement('div');
      rows.setAttribute('data-nav-container', 'rows');
      const row = focusable({ x: 0, y: 300 });
      row.dataset.key = 'ch:1';
      rows.append(row);
      const container = makeContainer(tiles, rows);
      const nav = new SpatialNav(container);
      nav.focus(row);
      const rows2 = document.createElement('div');
      rows2.setAttribute('data-nav-container', 'rows');
      const replacement = focusable({ x: 0, y: 300 });
      replacement.dataset.key = 'ch:1';
      rows2.append(replacement);
      container.replaceChild(rows2, rows);

      expect(nav.move('right')).toBe(false);
      expect(nav.focused).toBe(replacement);
    });

    it('does not adopt a same-key element inside a trap the lost focus sat outside', () => {
      const outside = focusable({ x: 0, y: 300 });
      outside.dataset.key = 'row';
      const menu = document.createElement('div');
      const first = focusable({ x: 200, y: 0 });
      const keyed = focusable({ x: 200, y: 300 });
      keyed.dataset.key = 'row';
      menu.append(first, keyed);
      const container = makeContainer(outside, menu);
      const nav = new SpatialNav(container);
      nav.focus(outside);
      nav.setRestrict(menu);
      container.removeChild(outside);

      nav.move('down');
      expect(nav.focused).toBe(first);
    });
  });

  describe('recovery once focus is gone from the view', () => {
    it('recovers on the keyed replacement on the next move', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      b.dataset.key = 'row-b';
      const container = makeContainer(a, b);
      const nav = new SpatialNav(container);
      nav.focus(b);
      const replacement = focusable({ x: 0, y: 300 });
      replacement.dataset.key = 'row-b';
      container.replaceChild(replacement, b);

      nav.move('down');
      expect(nav.focused).toBe(replacement);
    });

    it('recovers nearest where focus was on the next move', () => {
      const rows = [0, 100, 200, 300].map((y) => focusable({ x: 0, y }));
      const container = makeContainer(...rows);
      const nav = new SpatialNav(container);
      nav.focus(rows[3]);
      container.removeChild(rows[3]);

      nav.move('down');
      expect(nav.focused).toBe(rows[2]);
    });

    it('enters a trap at its first item when the element left outside it was removed', () => {
      const outside = focusable({ x: 0, y: 300 });
      const menu = document.createElement('div');
      const first = focusable({ x: 200, y: 0 });
      const near = focusable({ x: 200, y: 300 });
      menu.append(first, near);
      const container = makeContainer(outside, menu);
      const nav = new SpatialNav(container);
      nav.focus(outside);
      nav.setRestrict(menu);
      container.removeChild(outside);

      nav.move('down');
      expect(nav.focused).toBe(first);
    });

    it('does not recover after the trap changes', () => {
      const rows = [0, 100, 200, 300].map((y) => focusable({ x: 0, y }));
      const layer = document.createElement('div');
      layer.append(...rows);
      const container = makeContainer(layer);
      const nav = new SpatialNav(container);
      nav.focus(rows[3]);
      container.removeChild(layer);
      rows[3].remove();
      const other = document.createElement('div');
      other.append(...rows.slice(0, 3));
      container.append(other);
      nav.setRestrict(other);

      nav.move('down');
      expect(nav.focused).toBe(rows[0]);
    });

    it('keeps recovery when the same trap is set again', () => {
      const rows = [0, 100, 200, 300].map((y) => focusable({ x: 0, y }));
      const layer = document.createElement('div');
      layer.append(...rows);
      const container = makeContainer(layer);
      const nav = new SpatialNav(container);
      nav.setRestrict(layer);
      nav.focus(rows[3]);
      rows[3].remove();
      nav.setRestrict(layer);

      nav.move('down');
      expect(nav.focused).toBe(rows[2]);
    });

    it('does not recover after resetRecovery', () => {
      const rows = [0, 100, 200, 300].map((y) => focusable({ x: 0, y }));
      const container = makeContainer(...rows);
      const nav = new SpatialNav(container);
      nav.focus(rows[3]);
      container.removeChild(rows[3]);
      nav.resetRecovery();

      nav.move('down');
      expect(nav.focused).toBe(rows[0]);
    });

    it('does not recover after an explicit focus(null)', () => {
      const rows = [0, 100, 200].map((y) => focusable({ x: 0, y }));
      const container = makeContainer(...rows);
      const nav = new SpatialNav(container);
      nav.focus(rows[2]);
      nav.focus(null);

      nav.move('down');
      expect(nav.focused).toBe(rows[0]);
    });
  });

  describe('showConcealed and the kept ring', () => {
    it('counts CH+/CH- as focus moves only when asked', () => {
      expect(isFocusMove('down')).toBe(true);
      expect(isFocusMove('channel_up')).toBe(false);
      expect(isFocusMove('channel_down', true)).toBe(true);
    });

    it('moves instead of showing once the scope shows the ring for another reason', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav, scope } = bound(makeContainer(a, b));
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      scope.track(a.dataset.key ?? null, true);

      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(b);
    });

    it('asks its scope to bring the shown element into view', () => {
      const a = focusable({ x: 0, y: 0 });
      const { nav, scope } = bound(makeContainer(a));
      nav.focus(a);
      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      const focus = vi.spyOn(scope, 'focus');

      expect(nav.showConcealed()).toBe(true);
      expect(focus).toHaveBeenCalledWith(a.dataset.key, 'key');
      expect(nav.showConcealed()).toBe(false);
    });

    it('keeps its ring through a morph re-render, but not one the pointer hid', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const render = () => morph(container, html`<div data-nav-container>
        <div class="row" data-focusable data-key="a">A</div>
        <div class="row" data-focusable data-key="b">B</div>
      </div>`);
      render();
      const { nav } = bound(container);
      const a = container.querySelector<HTMLElement>('[data-key="a"]')!;
      nav.focus(a);

      render();
      Focus.flush();
      expect(a.className).toBe('row focused');

      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      render();
      expect(ringed(a)).toBe(false);
      container.remove();
    });
  });

  describe('move return value', () => {
    it('returns true when focus moves to a target', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focus(a);
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(b);
    });

    it('returns false at an edge (no target in that direction)', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const { nav } = bound(makeContainer(a, b));
      nav.focus(a);
      expect(nav.move('up')).toBe(false);
      expect(nav.focused).toBe(a);
      expect(ringed(a)).toBe(true);
    });

    it('returns true when nothing was focused yet (focuses the first item)', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(a);
    });

    it('returns false when there are no focusables', () => {
      const empty = document.createElement('div');
      document.body.appendChild(empty);
      const nav = new SpatialNav(empty);
      expect(nav.move('down')).toBe(false);
    });
  });

  describe('onFocusChange', () => {
    it('fires with the newly focused element on focus() and move()', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a, b), cb);
      nav.focus(a);
      expect(cb).toHaveBeenLastCalledWith(a);
      nav.move('down');
      expect(cb).toHaveBeenLastCalledWith(b);
    });

    it('does not fire when re-focusing the already-focused element', () => {
      const a = focusable({ x: 0, y: 0 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a), cb);
      nav.focus(a);
      cb.mockClear();
      nav.focus(a);
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires on nav:hover over a focusable', () => {
      const a = focusable({ x: 0, y: 0 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a), cb);
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(cb).toHaveBeenCalledWith(a);
      expect(nav.focused).toBe(a);
    });
  });
});
