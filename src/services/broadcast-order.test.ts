import { describe, expect, it } from 'vitest';
import type { BroadcastChannel } from './broadcast-normalize';
import { applyOrder, dropFromOrder, kindCount, moveInOrder } from './broadcast-order';

function channel(key: string, kind: 'tv' | 'radio' = 'tv'): BroadcastChannel {
  return {
    id: `id_${key}`, serviceKey: `${kind}:${key}`, number: 0, numberLabel: '', name: key, kind,
    source: 'satellite', satellite: '', frequency: 0, transponderId: 0, hd: false, scrambled: false,
    locked: false, logo: '',
  };
}

const lineup = [channel('ch1'), channel('ch2'), channel('ch3'), channel('ch4'), channel('r1', 'radio'), channel('r2', 'radio')];

function names(saved: string[], kind: 'tv' | 'radio' = 'tv'): string[] {
  return applyOrder(lineup, saved).channels.filter(item => item.kind === kind).map(item => item.name);
}

describe('moveInOrder', () => {
  it('starts from the TV order before anything was saved', () => {
    expect(names([])).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
  });

  it('puts a channel at the number and moves the others down', () => {
    const order = moveInOrder(lineup, [], 'tv:ch3', 1);
    expect(names(order)).toEqual(['ch3', 'ch1', 'ch2', 'ch4']);
    expect(applyOrder(lineup, order).channels[0]).toMatchObject({ name: 'ch3', number: 1, numberLabel: '1' });
  });

  it('moves a channel later and the ones between up', () => {
    expect(names(moveInOrder(lineup, [], 'tv:ch1', 3))).toEqual(['ch2', 'ch3', 'ch1', 'ch4']);
  });

  it('clamps a number past the end to the last place', () => {
    expect(names(moveInOrder(lineup, [], 'tv:ch2', 99))).toEqual(['ch1', 'ch3', 'ch4', 'ch2']);
    expect(names(moveInOrder(lineup, [], 'tv:ch2', 0))).toEqual(['ch2', 'ch1', 'ch3', 'ch4']);
  });

  it('numbers radio apart and leaves TV alone', () => {
    const order = moveInOrder(lineup, [], 'radio:r2', 1);
    expect(names(order, 'radio')).toEqual(['r2', 'r1']);
    expect(names(order)).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
  });

  it('keeps a service gone from the lineup in its slot', () => {
    const saved = ['tv:ch1', 'tv:gone', 'tv:ch2', 'tv:ch3', 'tv:ch4', 'radio:r1', 'radio:r2'];
    const order = moveInOrder(lineup, saved, 'tv:ch4', 1);
    expect(order[1]).toBe('tv:gone');
    expect(names(order)).toEqual(['ch4', 'ch1', 'ch2', 'ch3']);
  });

  it('builds on an earlier move', () => {
    const first = moveInOrder(lineup, [], 'tv:ch4', 1);
    expect(names(moveInOrder(lineup, first, 'tv:ch1', 4))).toEqual(['ch4', 'ch2', 'ch3', 'ch1']);
  });

  it('drops repeated keys a saved order picked up', () => {
    const order = moveInOrder(lineup, ['tv:ch1', 'tv:ch2', 'tv:ch1'], 'tv:ch2', 1);
    expect(order.filter(key => key === 'tv:ch1')).toHaveLength(1);
    expect(names(order)).toEqual(['ch2', 'ch1', 'ch3', 'ch4']);
  });

  it('returns the order unchanged for a service not in the lineup', () => {
    expect(moveInOrder(lineup, ['tv:ch2'], 'tv:none', 1)[0]).toBe('tv:ch2');
  });
});

describe('dropFromOrder', () => {
  it('forgets a deleted service so a rescan adds it at the end', () => {
    const saved = moveInOrder(lineup, [], 'tv:ch4', 1);
    const order = dropFromOrder(saved, ['tv:ch4']);
    expect(order).not.toContain('tv:ch4');
    expect(names(order)).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
  });
});

describe('kindCount', () => {
  it('counts the channels of one kind', () => {
    expect(kindCount(lineup, 'tv')).toBe(4);
    expect(kindCount(lineup, 'radio')).toBe(2);
  });
});
