// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PlayerStatus } from './player-status';

describe('centered playback status', () => {
  it('shows each pending state and clears when playback resumes', () => {
    const container = document.createElement('div');
    const status = new PlayerStatus(container);
    const root = container.querySelector('.player-status')!;
    status.set('loading', 'webOS');
    expect(root.textContent).toContain('Loading');
    expect(root.classList.contains('hidden')).toBe(false);
    status.set('buffering');
    expect(root.textContent).toContain('Buffering');
    status.set('reconnecting', 'mpegts.js');
    expect(root.textContent).toContain('Reconnecting');
    expect(root.textContent).toContain('mpegts.js');
    status.set('error');
    expect(root.textContent).toContain('Playback error.');
    status.set(null);
    expect(root.classList.contains('hidden')).toBe(true);
    expect(root.hasAttribute('data-state')).toBe(false);
    expect(root.querySelector('[data-focusable]')).toBeNull();
  });

  it('escapes the player label and reuses the same status root', () => {
    const container = document.createElement('div');
    const status = new PlayerStatus(container);
    status.set('loading', '<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img');
    new PlayerStatus(container);
    expect(container.querySelectorAll('.player-status')).toHaveLength(1);
  });

  it('updates and redacts error details, preserving them only within the same state', () => {
    const container = document.createElement('div');
    const status = new PlayerStatus(container);
    status.set('reconnecting', 'Player 1', 'HTTP 403 http://host/live/u/p/1.ts token=secret <img src=x>');
    expect(container.querySelector('.player-status-detail')?.textContent).toContain('HTTP 403');
    expect(container.textContent).not.toContain('http://host');
    expect(container.textContent).not.toContain('secret');
    expect(container.querySelector('img')).toBeNull();
    status.set('reconnecting', 'Player 2');
    expect(container.querySelector('.player-status-detail')?.textContent).toContain('HTTP 403');
    status.set('reconnecting', 'Player 2', 'HTTP 500');
    expect(container.querySelector('.player-status-detail')?.textContent).toBe('HTTP 500');
    status.set(null);
    status.set('loading');
    expect(container.querySelector('.player-status-detail')).toBeNull();
  });
});
