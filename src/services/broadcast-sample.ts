import type { BroadcastChannel, BroadcastProgram } from './broadcast-normalize';

// A synthetic lineup for engines without a tuner (the desktop preview and
// the webOS Simulator), so the Satellite section can be explored there.

const SATELLITES = ['Satellite A 13.0°E', 'Satellite B 19.2°E'];

const NAMES: Array<[string, 'tv' | 'radio', boolean, boolean]> = [
  ['Alpha One HD', 'tv', true, false],
  ['Alpha Two', 'tv', false, false],
  ['Bravo News', 'tv', false, false],
  ['Bravo News HD', 'tv', true, false],
  ['Charlie Sport HD', 'tv', true, true],
  ['Charlie Sport 2', 'tv', false, true],
  ['Delta Movies HD', 'tv', true, true],
  ['Delta Classics', 'tv', false, true],
  ['Echo Kids', 'tv', false, false],
  ['Foxtrot Music', 'tv', false, false],
  ['Golf Documentary HD', 'tv', true, false],
  ['Hotel Travel', 'tv', false, false],
  ['India Science HD', 'tv', true, true],
  ['Juliett Cooking', 'tv', false, false],
  ['Kilo Weather', 'tv', false, false],
  ['Lima Parliament', 'tv', false, false],
  ['Mike Shopping', 'tv', false, false],
  ['November Series HD', 'tv', true, true],
  ['Oscar Culture', 'tv', false, false],
  ['Papa Regional', 'tv', false, false],
  ['Quebec Comedy', 'tv', false, true],
  ['Romeo Nature UHD', 'tv', true, true],
  ['Sierra History', 'tv', false, false],
  ['Tango Arts', 'tv', false, false],
  ['Uniform Radio One', 'radio', false, false],
  ['Victor Radio Jazz', 'radio', false, false],
  ['Whiskey Radio Classic', 'radio', false, false],
  ['X-ray Radio News', 'radio', false, false],
];

export function sampleChannels(): BroadcastChannel[] {
  return NAMES.map(([name, kind, hd, scrambled], index) => {
    const number = index + 1;
    return {
      id: `sample_${String(number)}`,
      serviceKey: `${kind}:sample_${String(number)}`,
      number,
      numberLabel: String(number),
      name,
      kind,
      source: 'satellite',
      satellite: SATELLITES[index % 3 === 2 ? 1 : 0],
      frequency: 10700 + (index % 6) * 125,
      transponderId: 0,
      hd,
      scrambled,
      locked: false,
      logo: '',
    };
  });
}

const TITLES = [
  'Morning Edition', 'World Report', 'The Long Road', 'Studio Live', 'Open Air',
  'Deep Blue', 'City Lights', 'Evening Bulletin', 'Late Show', 'Night Journal',
];

// Half-hour and hour slots aligned to the clock, stable per channel.
export function samplePrograms(channel: BroadcastChannel, now: number): BroadcastProgram[] {
  const slot = 30 * 60000;
  let start = Math.floor(now / slot) * slot - (channel.number % 2 ? slot : 0);
  const programs: BroadcastProgram[] = [];
  for (let i = 0; i < 6; i++) {
    const length = (i + channel.number) % 3 === 0 ? slot * 2 : slot;
    const title = TITLES[(channel.number * 3 + i + Math.floor(start / slot)) % TITLES.length];
    programs.push({ title, start, end: start + length, description: '' });
    start += length;
  }
  return programs.filter(program => program.end > now);
}
