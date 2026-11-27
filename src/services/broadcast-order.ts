import type { BroadcastChannel } from './broadcast-normalize';

// The Satellite section keeps its own channel order, keyed by each service's
// broadcast identity: a rescan renumbers the TV's list and gives channels new
// ids, but a service keeps its place here, and services new to the list join
// at the end of their kind. TV and radio are numbered apart, as on the TV.

export interface OrderedLineup {
  channels: BroadcastChannel[];
  order: string[];
  changed: boolean;
}

export function applyOrder(list: readonly BroadcastChannel[], saved: readonly string[]): OrderedLineup {
  const rank = new Map<string, number>();
  saved.forEach((key, index) => { if (!rank.has(key)) rank.set(key, index); });
  const known: BroadcastChannel[] = [];
  const fresh: BroadcastChannel[] = [];
  const seen = new Set<string>();
  for (const channel of list) {
    if (seen.has(channel.serviceKey)) continue;
    seen.add(channel.serviceKey);
    (rank.has(channel.serviceKey) ? known : fresh).push(channel);
  }
  known.sort((a, b) => (rank.get(a.serviceKey) ?? 0) - (rank.get(b.serviceKey) ?? 0));
  // Services that went away keep their slot in the saved order, so a channel
  // that is off-air for one scan comes back where it was.
  const order = saved.slice();
  for (const channel of fresh) order.push(channel.serviceKey);
  const merged = [...known, ...fresh];
  const counters = { tv: 0, radio: 0 };
  const channels = [...merged.filter(c => c.kind === 'tv'), ...merged.filter(c => c.kind === 'radio')]
    .map((channel) => {
      const number = ++counters[channel.kind];
      return { ...channel, number, numberLabel: String(number) };
    });
  return { channels, order, changed: fresh.length > 0 || order.length !== saved.length };
}
