import { describe, expect, it, vi } from 'vitest';

const make = vi.fn();
vi.mock('qrcode-generator', () => ({
  default: () => ({ addData: () => undefined, make, createDataURL: () => `data:image/gif;base64,${String(make.mock.calls.length)}` }),
}));

const { qrDataUrl } = await import('./qr');

describe('qrDataUrl', () => {
  it('encodes a link once while views re-render it', () => {
    const first = qrDataUrl('http://host/a');
    expect(qrDataUrl('http://host/a')).toBe(first);
    expect(make).toHaveBeenCalledTimes(1);
    expect(qrDataUrl('http://host/b')).not.toBe(first);
    expect(make).toHaveBeenCalledTimes(2);
  });
});
