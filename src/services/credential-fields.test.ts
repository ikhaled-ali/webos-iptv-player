// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshots } = vi.hoisted(() => ({ snapshots: [] as unknown[] }));
vi.mock('./credential-vault', () => ({
  vaultReady: () => true,
  seal: async (value: unknown) => {
    snapshots.push(value);
    return { version: 1, iv: 'synthetic-iv', data: 'synthetic-ciphertext' };
  },
  unseal: async () => snapshots[snapshots.length - 1],
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  snapshots.length = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('credential-only storage', () => {
  it('encrypts credential values once while leaving ordinary guide data in native form', async () => {
    const fields = await import('./credential-fields');
    const start = new Date('2024-01-01T00:00:00Z');
    const programmes = [{ start, title: 'p1', description: 'description1' }];
    const source = {
      username: 'user1', password: 'secret1',
      channels: Array.from({ length: 1000 }, (_, id) => ({
        name: 'ch' + id, url: 'http://host/live/user1/secret1/' + id,
      })),
      programmes,
    };
    const stored = await fields.protectCredentialFields(source);
    expect(stored.programmes).toBe(programmes);
    expect(stored.programmes[0].start).toBe(start);
    expect(stored.channels[0].name).toBe('ch0');
    expect(JSON.stringify(stored)).not.toContain('secret1');
    expect(snapshots).toHaveLength(1);
    expect(Object.values(snapshots[0] as object).sort()).toEqual(['secret1', 'user1']);
    expect(await fields.revealCredentialFields(stored)).toEqual(source);
  });

  it('restores encoded credentials, query tokens, and URL-bearing record keys exactly', async () => {
    const fields = await import('./credential-fields');
    const url = 'http://host/live/user%201/secret%2B1/1?token=token1&key=key1';
    const source = { [url]: { url, password: 'secret+1' } };
    const protectedValue = await fields.protectCredentialFields(source);
    expect(JSON.stringify(protectedValue)).not.toContain('token1');
    expect(JSON.stringify(protectedValue)).not.toContain('key1');
    expect(await fields.revealCredentialFields(protectedValue)).toEqual(source);
    vi.resetModules();
    expect(await (await import('./credential-fields')).revealCredentialFields(protectedValue)).toEqual(source);
  });

  it('commits credential references before allowing their records to be saved', async () => {
    const fields = await import('./credential-fields');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      await expect(fields.protectCredentialFields({ password: 'secret1' })).rejects.toThrow('quota');
    } finally { spy.mockRestore(); }
    expect(await fields.protectCredentialFields({ password: 'secret1' })).toHaveProperty('password');
    expect(localStorage.getItem(fields.credentialFieldsStorageKey())).not.toBeNull();
  });

  it('does not copy or encrypt ordinary records', async () => {
    const fields = await import('./credential-fields');
    const ordinary = { theme: 'dark', programmes: [{ title: 'p1', description: 'description1' }] };
    expect(await fields.protectCredentialFields(ordinary)).toBe(ordinary);
    expect(snapshots).toHaveLength(0);
  });
});
