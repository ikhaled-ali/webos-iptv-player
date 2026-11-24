// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const { healthMock } = vi.hoisted(() => ({
  healthMock: { getRecord: vi.fn((): { status: string } | null => null) },
}));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));
vi.mock('./parental-badge', () => ({
  channelLockBadge: (channel: Channel) => (channel.id === 'locked' ? '<span class="lock-badge is-locked"></span>' : ''),
}));

import { html, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { channelCard, channelSeeAllCard, posterCard, posterSeeAllCard } from './item-cards';

const channel = (id: string, logo = ''): Channel => ({
  id, name: `<b>${id}</b>`, logo, group: 'Alpha', url: `http://host/${id}`, extras: null, playlistIds: [],
} as unknown as Channel);

function mount(markup: Safe): HTMLElement {
  const host = document.createElement('div');
  morph(host, markup);
  return host.firstElementChild as HTMLElement;
}

beforeEach(() => {
  healthMock.getRecord.mockReturnValue(null);
});

describe('channelCard', () => {
  it('draws one focusable card with its key, attributes, and escaped name', () => {
    const card = mount(channelCard({
      key: 'ch:3', channel: channel('ch1'), subtitle: '<i>Track 1</i>',
      attrs: html`data-channel-index="${3}"`,
    }));
    expect(card.classList.contains('channel-tile')).toBe(true);
    expect(card.hasAttribute('data-focusable')).toBe(true);
    expect(card.dataset.key).toBe('ch:3');
    expect(card.dataset.channelIndex).toBe('3');
    expect(card.querySelector('.channel-name')?.textContent).toBe('<b>ch1</b>');
    expect(card.querySelector('.channel-now')?.textContent).toBe('<i>Track 1</i>');
    expect(card.querySelector('b, i')).toBeNull();
  });

  it('shows the lock, favorite, health, and playing state', () => {
    healthMock.getRecord.mockReturnValue({ status: 'suspect' });
    const card = mount(channelCard({ key: 'k', channel: channel('locked'), favorite: true, playing: true }));
    expect(card.classList.contains('playing')).toBe(true);
    expect(card.querySelector('.channel-name .lock-badge')).not.toBeNull();
    expect(card.querySelector('.channel-name .favorite-glyph')).not.toBeNull();
    expect(card.querySelector('.channel-tile-status .channel-health-dot.suspect')).not.toBeNull();
    expect(card.querySelector('.channel-tile-status .playing-indicator')).not.toBeNull();
  });

  it('leaves out the health dot when asked, and a logo that failed to load', () => {
    healthMock.getRecord.mockReturnValue({ status: 'healthy' });
    const card = mount(channelCard({
      key: 'k', channel: channel('ch1', 'http://host/a.png'), health: false, logoFailed: true,
    }));
    expect(card.querySelector('.channel-health-dot')).toBeNull();
    expect(card.querySelector('.channel-logo')).toBeNull();
    expect(card.querySelector('.channel-logo-wrap')).not.toBeNull();
  });

  it('falls back to the title initial without a channel', () => {
    const card = mount(channelCard({ key: 'k', channel: null, title: 'Track 1' }));
    expect(card.querySelector('.channel-logo-placeholder')?.textContent).toBe('T');
    expect(card.querySelector('.channel-name')?.textContent).toBe('Track 1');
  });

  it('draws See all as a channel card', () => {
    const card = mount(channelSeeAllCard('recent:all', html`data-home-see-all="recent"`));
    expect(card.classList.contains('channel-tile')).toBe(true);
    expect(card.dataset.key).toBe('recent:all');
    expect(card.querySelector('.catalog-see-all-icon')).not.toBeNull();
  });
});

describe('posterCard', () => {
  it('draws the poster, lock, progress, and escaped title', () => {
    const card = mount(posterCard({
      key: 'v:1', name: '<b>Alpha</b>', poster: 'http://host/a.jpg',
      lock: '<span class="lock-badge is-locked"></span>', progress: { position: 30, duration: 60 },
      attrs: html`data-stream-id="1"`,
    }));
    expect(card.dataset.key).toBe('v:1');
    expect(card.dataset.streamId).toBe('1');
    expect(card.hasAttribute('data-focusable')).toBe(true);
    expect(card.querySelector('img.catalog-poster')?.getAttribute('src')).toBe('http://host/a.jpg');
    expect(card.querySelector('.catalog-poster-wrap .lock-badge')).not.toBeNull();
    expect((card.querySelector('.catalog-progress-fill') as HTMLElement).style.width).toBe('50%');
    expect(card.querySelector('.catalog-tile-name')?.textContent).toBe('<b>Alpha</b>');
  });

  it('shows the initial without a poster, no bar without a duration, and no focus while managed', () => {
    const card = mount(posterCard({
      key: 'r:1', name: 'Bravo', poster: '', progress: { position: 30, duration: 0 }, focusable: false,
    }));
    expect(card.querySelector('.catalog-poster-empty')?.textContent).toBe('B');
    expect(card.querySelector('.catalog-progress')).toBeNull();
    expect(card.hasAttribute('data-focusable')).toBe(false);
  });

  it('draws See all with its count only when given', () => {
    const counted = mount(posterSeeAllCard({ key: 'all:1', count: '21 movies' }));
    expect(counted.querySelector('.catalog-see-all-count')?.textContent).toBe('21 movies');
    expect(mount(posterSeeAllCard({ key: 'top:all' })).querySelector('.catalog-see-all-count')).toBeNull();
  });
});
