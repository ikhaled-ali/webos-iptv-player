// Shared inline SVG icons — the single source of truth for the app's icon
// markup. On webOS the WebView can't reach the last-resort font that some
// Unicode glyphs fall through to, so UI icons are inline SVGs drawn with
// `currentColor`. These are trusted raw markup strings — wrap them with `raw()`
// (or interpolate into an `html` template / assign to `innerHTML`) at the call
// site.

export const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
export const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
export const NEXT_EPISODE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
// Seek arrows carry their step in seconds, drawn as plain digits the TV font has.
export function seekIcon(direction: 'back' | 'forward', seconds: number): string {
  const arc = direction === 'back'
    ? '<path d="M4.6 8.5A8.2 8.2 0 1 1 3.8 13"/><path d="M4.2 3.8v4.9h4.9"/>'
    : '<path d="M19.4 8.5A8.2 8.2 0 1 0 20.2 13"/><path d="M19.8 3.8v4.9h-4.9"/>';
  const x = direction === 'back' ? 12.6 : 11.4;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${arc}<text x="${String(x)}" y="15.4" font-size="7.6" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">${String(seconds)}</text></svg>`;
}

// Magnifier (tab bar search).
export const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';
// Standard eight-tooth gear.
export const SETTINGS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M9.62 5.10L10.30 2.35L13.70 2.35L14.38 5.10L15.20 5.44L17.62 3.97L20.03 6.38L18.56 8.80L18.90 9.62L21.65 10.30L21.65 13.70L18.90 14.38L18.56 15.20L20.03 17.62L17.62 20.03L15.20 18.56L14.38 18.90L13.70 21.65L10.30 21.65L9.62 18.90L8.80 18.56L6.38 20.03L3.97 17.62L5.44 15.20L5.10 14.38L2.35 13.70L2.35 10.30L5.10 9.62L5.44 8.80L3.97 6.38L6.38 3.97L8.80 5.44Z"/><circle cx="12" cy="12" r="3.2"/></svg>';
// Solid section glyphs for the tab bar's text tabs.
export const TAB_LIVE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 2.3 12 5.8l3.5-3.5 1.1 1.1L14 6h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6L7.4 3.4z"/></svg>';
export const TAB_GUIDE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm1 4v2h4V7H5zm6 0v2h8V7h-8zm-6 4v2h4v-2H5zm6 0v2h8v-2h-8zm-6 4v2h4v-2H5zm6 0v2h8v-2h-8z"/></svg>';
export const TAB_MOVIES_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm.5 3v2h2V6h-2zm0 5v2h2v-2h-2zm0 5v2h2v-2h-2zm13-10v2h2V6h-2zm0 5v2h2v-2h-2zm0 5v2h2v-2h-2zM10 8.5v7l5.5-3.5L10 8.5z"/></svg>';
export const TAB_SERIES_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M6 2.5h12v1.8H6V2.5zM4 5.2h16V7H4V5.2zm0 3.3h16a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2zm6 3.1v6.3l5-3.15-5-3.15z"/></svg>';
export const CHEVRON_LEFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>';
export const SEE_ALL_ICON = '<svg class="catalog-see-all-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
export const CHEVRON_RIGHT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
export const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
export const UNLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.75-1.4"/></svg>';
export const CHEVRON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
export const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
export const SORT_ASCENDING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 19V5m-3 3 3-3 3 3M13 6h3m-3 6h5m-5 6h8"/></svg>';
export const SORT_DESCENDING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5v14m-3-3 3 3 3-3M13 6h8m-8 6h5m-5 6h3"/></svg>';
export const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-5 4 5 4"/><path d="M5 12h9a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4h-4"/></svg>';
export const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg>';
export const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg>';
export const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.5 2h5a1 1 0 0 1 1 1v1H20a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4.5V3a1 1 0 0 1 1-1zM5 8.5h14l-.9 11.1A2.5 2.5 0 0 1 15.6 22H8.4a2.5 2.5 0 0 1-2.5-2.4L5 8.5zm4.1 3v7h1.8v-7H9.1zm4 0v7h1.8v-7h-1.8z"/></svg>';
export const VOLUME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>';
export const VOLUME_MUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/></svg>';
export const FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg>';

const FAVORITE_PATH = 'm12 2.8 2.84 5.75 6.35.92-4.6 4.48 1.09 6.32L12 17.28l-5.68 2.99 1.09-6.32-4.6-4.48 6.35-.92L12 2.8z';
export function favoriteIcon(active: boolean): string {
  return `<svg class="favorite-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="${FAVORITE_PATH}"/></svg>`;
}

// Settings sidebar categories. Stroke/fill styling is supplied by settings.css.
export const GLOBE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M4.2 8.5c2.2 1.1 4.9 1.7 7.8 1.7s5.6-.6 7.8-1.7M4.2 15.5c2.2-1.1 4.9-1.7 7.8-1.7s5.6.6 7.8 1.7M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/></svg>';
export const SOURCES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/></svg>';
export const GUIDE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 9h18M8 3v4M16 3v4M7 13h3M14 13h3M7 17h3"/></svg>';
export const APPEARANCE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>';
export const PLAYBACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
export const CAPTIONS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 14h6M14 14h5M5 17h4M12 17h7"/></svg>';
export const DATABASE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
export const ADVANCED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
export const NAV_VERTICAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>';
export const NAV_HORIZONTAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>';

// Speed gauge (player menu playback-speed row).
export const SPEED_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="m20.38 8.57-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>';
// Beamed eighth notes (player menu audio-track row).
export const AUDIO_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M21 2v13a3.2 3.2 0 1 1-1.8-2.88V6.4l-8.4 1.9V17.5a3.2 3.2 0 1 1-1.8-2.88V4.6z"/></svg>';
// Closed-caption card (player menu subtitles row).
export const SUBTITLE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 7v2h6v-2H6zm8 0v2h4v-2h-4zM6 8v2h4V8H6zm6 0v2h6V8h-6z"/></svg>';

// Replay arrow marking an aired (catch-up) programme in the EPG.
export const REPLAY_ICON = '<svg class="epg-replay-glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';

// Sync (two circular arrows) — the player OSD "Resync A/V" button.
export const RESYNC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';

// Sliders — the player OSD button that opens the player menu.
export const PLAYER_MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';

// Reminder bell — dim on a future programme ("OK sets a reminder"), accent once
// set; the state class drives the fill in CSS.
const BELL_PATH = 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z';
export function bellIcon(active: boolean): string {
  return `<svg class="epg-bell-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path fill="currentColor" d="${BELL_PATH}"/></svg>`;
}

// Download count badge on an online-subtitle search result row.
export const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

// Check mark for the current row in the account switcher (no exotic Unicode).
export const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

const WATCHLIST_PATH = 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z';
export function watchlistIcon(active: boolean): string {
  return `<svg class="watchlist-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="${WATCHLIST_PATH}"/></svg>`;
}

// The app icon (assets/icon.svg) without its launcher tile: "iP" with a
// play button as the dot of the i, a small "TV" under the P's bowl, and one
// signal arc to the bowl's right. The
// letters are outlined glyphs, so no font is involved; tab-bar.css colors
// them and the play button from the theme. icons.test.ts keeps the drawing in step with the asset.
export const APP_LOGO = '<svg class="app-logo" viewBox="15.85 14 55.5 52" role="img" aria-label="iPlayer">'
  + '<path class="app-logo-play" d="M19 18.6v7.8l6.6-3.9z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3.6" stroke-linejoin="round"/>'
  + '<rect class="app-logo-letter" x="17.4" y="32.5" width="8.5" height="30" rx="4.25" fill="#FFFFFF"/>'
  + '<path class="app-logo-letter" d="M36.63 62.5C39.3 62.5 40.87 60.87 40.87 58.1V49.21H48.44C56.97 49.21 62.88 43.65 62.88 35.35C62.88 27.02 57.16 21.5 48.86 21.5H36.63C33.97 21.5 32.4 23.13 32.4 25.9V58.1C32.4 60.87 33.97 62.5 36.63 62.5ZM40.87 42.59V28.2H46.62C51.47 28.2 54.27 30.78 54.27 35.38C54.27 40.01 51.44 42.59 46.59 42.59Z" fill="#FFFFFF"/>'
  + '<path class="app-logo-tv" d="M48.94 62.65C49.71 62.65 50.16 62.19 50.16 61.38V54.87H51.85C52.49 54.87 52.93 54.51 52.93 53.88C52.93 53.26 52.51 52.9 51.85 52.9H46.04C45.38 52.9 44.95 53.26 44.95 53.88C44.95 54.51 45.39 54.87 46.04 54.87H47.72V61.38C47.72 62.19 48.17 62.65 48.94 62.65ZM58.4 62.65C59.39 62.65 59.99 62.19 60.36 61.16L62.76 54.54C62.84 54.32 62.88 54.12 62.88 53.89C62.88 53.21 62.37 52.75 61.62 52.75C60.97 52.75 60.59 53.05 60.41 53.7L58.48 60.11H58.43L56.49 53.73C56.29 53.06 55.9 52.75 55.22 52.75C54.45 52.75 53.93 53.23 53.93 53.93C53.93 54.18 53.97 54.4 54.05 54.62L56.43 61.16C56.8 62.19 57.39 62.65 58.4 62.65Z" fill="#FFFFFF"/>'
  + '<path class="app-logo-signal" d="M65.89 25.6A19.5 19.5 0 0 1 65.89 45.1" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>'
  + '</svg>';

// Weather conditions beside the clock: outline glyphs on the 24px grid, each
// part in its own color (sun, moon, cloud, rain, snow, lightning, fog).
const WEATHER_SUN_COLOR = '#ffb627';
const WEATHER_MOON_COLOR = '#f2e3a0';
const WEATHER_CLOUD_COLOR = '#dfe6ee';
const WEATHER_RAIN_COLOR = '#4ea8ff';
const WEATHER_SNOW_COLOR = '#a8dcff';
const WEATHER_BOLT_COLOR = '#ffd23f';
const WEATHER_FOG_COLOR = '#aab4bf';
const tint = (color: string, parts: string): string => `<g stroke="${color}">${parts}</g>`;
const WEATHER_CLOUD_TOP = tint(WEATHER_CLOUD_COLOR, '<path d="M7 14.5h10a3.75 3.75 0 0 0 .6-7.45A5.2 5.2 0 0 0 7.6 7.5 3.5 3.5 0 0 0 7 14.5z"/>');
const WEATHER_SMALL_CLOUD = tint(WEATHER_CLOUD_COLOR, '<path d="M9.5 20h8a3.5 3.5 0 0 0 .5-6.96A4.8 4.8 0 0 0 9.3 14 3 3 0 0 0 9.5 20z"/>');
const WEATHER_PATHS: Record<string, string> = {
  'clear-day': tint(WEATHER_SUN_COLOR, '<circle cx="12" cy="12" r="4" fill="' + WEATHER_SUN_COLOR + '"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  'clear-night': tint(WEATHER_MOON_COLOR, '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z" fill="' + WEATHER_MOON_COLOR + '"/>'),
  'partly-cloudy-day': tint(WEATHER_SUN_COLOR, '<circle cx="8" cy="8" r="3" fill="' + WEATHER_SUN_COLOR + '"/><path d="M8 2.5v1M2.5 8h1M4.1 4.1l.7.7M11.9 4.1l-.7.7"/>') + WEATHER_SMALL_CLOUD,
  'partly-cloudy-night': tint(WEATHER_MOON_COLOR, '<path d="M12 6.8A4.5 4.5 0 1 1 6.2 2.9a3.6 3.6 0 0 0 5.8 3.9z" fill="' + WEATHER_MOON_COLOR + '"/>') + WEATHER_SMALL_CLOUD,
  cloudy: tint(WEATHER_CLOUD_COLOR, '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 11 3.75 3.75 0 0 0 7 18.5z"/>'),
  fog: tint(WEATHER_FOG_COLOR, '<path d="M4 8h16M3 12h13M6 16h14M8 20h9"/>'),
  drizzle: WEATHER_CLOUD_TOP + tint(WEATHER_RAIN_COLOR, '<path d="M9 18v1M13 18v1M17 18v1"/>'),
  rain: WEATHER_CLOUD_TOP + tint(WEATHER_RAIN_COLOR, '<path d="M9.5 17l-1.2 3.5M13.5 17l-1.2 3.5M17.5 17l-1.2 3.5"/>'),
  snow: WEATHER_CLOUD_TOP + '<g fill="' + WEATHER_SNOW_COLOR + '"><circle cx="9" cy="18.5" r="1.1"/><circle cx="13" cy="20.5" r="1.1"/><circle cx="17" cy="18.5" r="1.1"/></g>',
  thunderstorm: WEATHER_CLOUD_TOP + tint(WEATHER_BOLT_COLOR, '<path d="M13 15.5l-2.5 3.5h3l-2 3.5"/>'),
};

export function weatherIcon(condition: string, isDay: boolean): string {
  const key = condition === 'clear' || condition === 'partly-cloudy'
    ? `${condition}-${isDay ? 'day' : 'night'}`
    : condition;
  return `<svg class="weather-${key}" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WEATHER_PATHS[key] ?? WEATHER_PATHS.cloudy}</svg>`;
}
