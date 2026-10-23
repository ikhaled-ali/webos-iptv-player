// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sealMock } = vi.hoisted(() => ({ sealMock: vi.fn() }));
vi.mock('./credential-vault', () => ({
  initCredentialVault: async () => {},
  seal: sealMock,
  unseal: async (value: { data: string }) => JSON.parse(value.data),
  vaultReady: () => false,
}));

function snapshot(value: unknown): { version: number; iv: string; data: string } {
  return { version: 1, iv: 'synthetic-iv', data: JSON.stringify(value) };
}

function savedValues(): Record<string, string> {
  return { iptv_playlists: localStorage.getItem('iptv_playlists')! };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sealMock.mockReset().mockImplementation(async value => snapshot(value));
});
afterEach(() => vi.restoreAllMocks());

describe('encrypted settings flush', () => {
  it('retries the latest unsaved settings after storage recovers', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    local.writeLocalValue('iptv_playlists', 'old-value');
    await local.flushSecureLocal();

    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full');
    });
    local.writeLocalValue('iptv_playlists', 'latest-value');
    await expect(local.flushSecureLocal()).rejects.toThrow('Storage full');
    expect(savedValues().iptv_playlists).toBe('old-value');

    write.mockRestore();
    await local.flushSecureLocal();
    expect(savedValues().iptv_playlists).toBe('latest-value');
    vi.resetModules();
    const restarted = await import('./secure-local');
    await restarted.initSecureLocal();
    expect(restarted.localValue('iptv_playlists')).toBe('latest-value');
  });

  it('keeps rejecting flushes while storage is unavailable', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    local.writeLocalValue('iptv_playlists', 'latest-value');

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(local.flushSecureLocal()).rejects.toThrow('Storage unavailable');
    }
  });

  it('clears an earlier failure once a newer snapshot has committed', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('Temporary failure');
    });
    local.writeLocalValue('iptv_playlists', 'old-value');
    local.writeLocalValue('iptv_playlists', 'latest-value');

    await expect(local.flushSecureLocal()).resolves.toBeUndefined();
    expect(savedValues().iptv_playlists).toBe('latest-value');
  });

  it('waits for a newer write queued while an earlier snapshot is encrypting', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
    const fields = await import('./credential-fields');
    const protect = vi.spyOn(fields, 'protectCredentialFields');
    protect.mockImplementationOnce(async value => { await firstGate; return value; });
    protect.mockImplementationOnce(async value => {
      secondStarted();
      await secondGate;
      return value;
    });
    local.writeLocalValue('iptv_playlists', 'old-value');
    let flushed = false;
    const flushing = local.flushSecureLocal().then(() => { flushed = true; });
    local.writeLocalValue('iptv_playlists', 'latest-value');
    releaseFirst();
    await secondReady;
    await Promise.resolve();
    try {
      expect(flushed).toBe(false);
    } finally {
      releaseSecond();
      await flushing;
    }
    expect(savedValues().iptv_playlists).toBe('latest-value');
  });
});
