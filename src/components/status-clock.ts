import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { clockTime, onClockTick } from '../utils/clock';
import type { Weather } from '../services/weather-service';
import { weatherIcon } from './icons';

let weather: Weather | null = null;
const clocks: StatusClock[] = [];

// Every clock on screen shows the same reading.
export function setStatusWeather(next: Weather): void {
  weather = next;
  clocks.forEach(clock => clock.renderWeather());
}

export function resetStatusWeatherForTests(): void {
  weather = null;
}

/**
 * The time of day and the current weather, side by side. Status, not
 * navigation: it never takes focus. The top menu and the player OSD each
 * own one and place it; a paused clock keeps its stale time until resumed.
 */
export class StatusClock {
  private active = true;

  constructor(private readonly root: HTMLElement) {
    root.classList.add('status-clock');
    clocks.push(this);
    this.render(clockTime());
    onClockTick(time => { if (this.active) this.setTime(time); });
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.setTime(clockTime());
  }

  renderWeather(): void {
    const slot = this.root.querySelector<HTMLElement>('.status-clock-weather');
    if (slot) morph(slot, weatherContent());
  }

  private render(time: string): void {
    morph(this.root, html`<time class="status-clock-time" data-key="time" datetime="${time}">${time}</time><span class="status-clock-weather" data-key="weather">${weatherContent()}</span>`);
  }

  // Only the time's text changes each minute.
  private setTime(time: string): void {
    const el = this.root.querySelector<HTMLElement>('.status-clock-time');
    if (!el) return;
    el.setAttribute('datetime', time);
    morph(el, html`${time}`);
  }
}

function weatherContent(): Safe {
  const w = weather;
  if (!w) return html``;
  return html`<span class="status-clock-weather-icon">${raw(weatherIcon(w.condition, w.isDay))}</span><span class="status-clock-weather-temp">${String(w.temperature)}°</span>`;
}
