import type { BroadcastChannel, BroadcastKind } from './broadcast-normalize';

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

// The saved order with `key` at `position` (1-based, clamped) among the
// lineup's channels of its kind. The other kind, and services gone from
// the lineup, keep their slots.
export function moveInOrder(
  lineup: readonly BroadcastChannel[],
  saved: readonly string[],
  key: string,
  position: number,
): string[] {
  const { channels, order } = applyOrder(lineup, saved);
  const moved = channels.find(channel => channel.serviceKey === key);
  if (!moved) return order;
  const kindKeys = channels.filter(channel => channel.kind === moved.kind).map(channel => channel.serviceKey);
  const sequence = kindKeys.filter(item => item !== key);
  const at = Math.max(0, Math.min(sequence.length, Math.round(position) - 1));
  sequence.splice(at, 0, key);
  const slots = new Set(kindKeys);
  const placed = new Set<string>();
  let next = 0;
  const result: string[] = [];
  for (const item of order) {
    if (placed.has(item)) continue;
    placed.add(item);
    result.push(slots.has(item) ? sequence[next++] : item);
  }
  return result;
}

// The saved order without a deleted service, so a rescan that finds it
// again adds it at the end rather than back in its old place.
export function dropFromOrder(saved: readonly string[], keys: readonly string[]): string[] {
  const gone = new Set(keys);
  return saved.filter(item => !gone.has(item));
}

export function kindCount(channels: readonly BroadcastChannel[], kind: BroadcastKind): number {
  let count = 0;
  for (const channel of channels) if (channel.kind === kind) count++;
  return count;
}
