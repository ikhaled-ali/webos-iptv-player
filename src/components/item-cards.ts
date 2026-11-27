import type { Channel, ChannelHealthStatus } from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { ChannelHealthService } from '../services/channel-health';
import { t, type TextMessageKey } from '../i18n';
import { channelLockBadge } from './parental-badge';
import { posterThumb, requestPosterThumb } from '../utils/poster-thumbs';
import { favoriteIcon, SEE_ALL_ICON, TAB_LIVE_ICON, TAB_MOVIES_ICON, TAB_SERIES_ICON } from './icons';

// The one channel card and one poster card every surface draws (Live, Home,
// Movies/Series, Search), so an item looks and focuses the same wherever it
// appears. Each surface keeps its own keys, data attributes, and layout.

export interface ChannelCardOptions {
  key: string;
  // null when the channel is gone (a reminder for a removed channel).
  channel: Channel | null;
  // The first line; the channel's name by default.
  title?: string;
  subtitle?: string | null;
  favorite?: boolean;
  playing?: boolean;
  // A logo that failed to load stays out, leaving the empty art box.
  logoFailed?: boolean;
  // The health dot, on by default.
  health?: boolean;
  // Extra state badges in the top corner, before the playing mark.
  status?: Safe | '';
  // Drawn over the art box, such as a catch-up progress bar.
  overlay?: Safe | '';
  // Trusted attribute markup built with `html`.
  attrs?: Safe;
  classes?: string;
  style?: string;
}

const HEALTH_LABEL: Record<ChannelHealthStatus, TextMessageKey> = {
  healthy: 'channel.healthHealthy',
  suspect: 'channel.healthSuspect',
  unavailable: 'channel.healthUnavailable',
};

export function channelHealthDot(channel: Channel): Safe | '' {
  const status = ChannelHealthService.getRecord(channel)?.status;
  if (!status) return '';
  const label = t(HEALTH_LABEL[status]);
  return html`
    <span class="channel-health-status channel-health-dot ${status}" title="${label}"
          aria-label="${label}"></span>
  `;
}

export type ArtKind = 'channel' | 'movie' | 'series';

const ART_ICON: Record<ArtKind, string> = {
  channel: TAB_LIVE_ICON,
  movie: TAB_MOVIES_ICON,
  series: TAB_SERIES_ICON,
};

// The kind's glyph, drawn under the image: it shows while the image loads,
// when it fails, and when the item has none.
export function artPlaceholder(kind: ArtKind): Safe {
  return html`<span class="art-placeholder">${raw(ART_ICON[kind])}</span>`;
}

// Image outcomes by URL, so a re-render keeps them: morph() drops any class
// the template doesn't carry.
const loadedArt = new Set<string>();
const failedArt = new Set<string>();
let artListening = false;

function onArtEvent(e: Event): void {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-art')) return;
  // A thumbnail keys its outcome by the poster it stands for.
  const src = img.getAttribute('data-art') || img.getAttribute('src');
  if (!src) return;
  const failed = e.type === 'error';
  (failed ? failedArt : loadedArt).add(src);
  if (!failed && img.hasAttribute('data-thumb')) requestPosterThumb(src, img.naturalWidth);
  img.parentElement?.classList.add(failed ? 'art-failed' : 'art-loaded');
}

function listenForArt(): void {
  if (artListening || typeof document === 'undefined') return;
  artListening = true;
  document.addEventListener('load', onArtEvent, true);
  document.addEventListener('error', onArtEvent, true);
}

// The art box's state class for an image URL ('' while it loads).
function artState(src: string, failed = false): string {
  if (!src || failed || failedArt.has(src)) return 'art-failed';
  return loadedArt.has(src) ? 'art-loaded' : '';
}

export function channelLogo(channel: Channel | null, failed = false): Safe {
  listenForArt();
  const src = channel?.logo ?? '';
  const state = artState(src, failed);
  return html`<div class="channel-logo-wrap art-box ${state}">${artPlaceholder('channel')}${
    state === 'art-failed' ? '' : html`<img class="channel-logo" data-art src="${src}" alt="" loading="lazy" decoding="async">`}</div>`;
}

export const PLAYING_MARK = raw('<div class="playing-indicator">&#9654;</div>');

export function channelCard(options: ChannelCardOptions): Safe {
  const { channel, playing = false } = options;
  const title = options.title ?? channel?.name ?? '';
  return html`
    <div class="channel-item channel-tile ${playing ? 'playing' : ''} ${options.classes ?? ''}"
         data-focusable data-key="${options.key}" ${options.attrs ?? ''}
         ${options.style ? html`style="${options.style}"` : ''}>
      <div class="channel-tile-art">
        ${channelLogo(channel, options.logoFailed)}
        <div class="channel-tile-status">
          ${channel && options.health !== false ? channelHealthDot(channel) : ''}
          ${options.status ?? ''}
          ${playing ? PLAYING_MARK : ''}
        </div>
        ${options.overlay ?? ''}
      </div>
      <div class="channel-info">
        <div class="channel-name">${channel ? raw(channelLockBadge(channel)) : ''}${
          options.favorite ? raw(favoriteIcon(true)) : ''}${title}</div>
        ${options.subtitle ? html`<div class="channel-now">${options.subtitle}</div>` : ''}
      </div>
    </div>
  `;
}

export function channelSeeAllCard(key: string, attrs?: Safe): Safe {
  return html`
    <div class="channel-item channel-tile channel-see-all" data-focusable data-key="${key}" ${attrs ?? ''}>
      <div class="channel-tile-art">${raw(SEE_ALL_ICON)}</div>
      <div class="channel-info"><div class="channel-name">${t('catalog.seeAll')}</div></div>
    </div>
  `;
}

export interface PosterCardOptions {
  key: string;
  name: string;
  poster: string;
  art: ArtKind;
  // Trusted lock-badge markup (from parental-badge).
  lock?: string | Safe;
  // Watch progress in seconds; a bar shows when the duration is known.
  progress?: { position: number; duration: number };
  // Drawn over the poster after the badges, such as a remove mark.
  overlay?: Safe | '';
  // False while a rail is being managed and its own marks take focus.
  focusable?: boolean;
  attrs?: Safe;
}

// The poster with its placeholder, filling the box it sits in (an art-box).
// A tile (`thumb`) draws the poster's small copy once one exists.
export function posterImage(kind: ArtKind, poster: string, thumb = false): Safe {
  listenForArt();
  if (artState(poster) === 'art-failed') return artPlaceholder(kind);
  const src = (thumb && posterThumb(poster)) || poster;
  return html`${artPlaceholder(kind)}<img class="catalog-poster" data-art="${poster}" ${
    thumb ? raw('data-thumb') : ''} src="${src}" alt="" loading="lazy" decoding="async">`;
}

// The class for the box a posterImage() sits in.
export function artBoxClass(poster: string): string {
  return `art-box ${artState(poster)}`;
}

export function progressBar(position: number, duration: number): Safe | '' {
  if (duration <= 0) return '';
  const percent = Math.max(2, Math.min(100, Math.round(position / duration * 100)));
  return html`<div class="catalog-progress"><div class="catalog-progress-fill" style="width:${percent}%"></div></div>`;
}

export function posterCard(options: PosterCardOptions): Safe {
  const { progress } = options;
  return html`
    <div class="catalog-tile" ${raw(options.focusable === false ? '' : 'data-focusable')}
         data-key="${options.key}" ${options.attrs ?? ''}>
      <div class="catalog-poster-wrap ${artBoxClass(options.poster)}">${posterImage(options.art, options.poster, true)}${
        raw(String(options.lock ?? ''))}${progress ? progressBar(progress.position, progress.duration) : ''}${
        options.overlay ?? ''}</div>
      <div class="catalog-tile-name" dir="auto">${options.name}</div>
    </div>
  `;
}

export interface PosterSeeAllOptions {
  key: string;
  // The localized total ("120 movies"), where the rail has one.
  count?: string;
  lock?: string;
  attrs?: Safe;
  selfActivate?: boolean;
}

export function posterSeeAllCard(options: PosterSeeAllOptions): Safe {
  return html`
    <div class="catalog-tile catalog-see-all" ${raw(options.selfActivate ? 'data-self-activate' : '')}
         data-focusable data-key="${options.key}" ${options.attrs ?? ''}>
      <div class="catalog-poster-wrap catalog-see-all-card">
        ${raw(options.lock ?? '')}
        ${raw(SEE_ALL_ICON)}
        <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
        ${options.count ? html`<div class="catalog-see-all-count">${options.count}</div>` : ''}
      </div>
    </div>
  `;
}
