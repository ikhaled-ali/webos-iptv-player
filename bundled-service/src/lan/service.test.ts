import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startServerMock } = vi.hoisted(() => ({ startServerMock: vi.fn() }));
vi.mock('./server', () => ({ startServer: startServerMock }));
import { registerLanService } from './service';

type Message = { sender?: string; respond: ReturnType<typeof vi.fn>; payload?: unknown };

function service() {
  const methods: Record<string, (message: Message) => void> = {};
  const luna = {
    register: (name: string, handler: (message: Message) => void) => { methods[name] = handler; },
    activityManager: {
      create: vi.fn(), complete: vi.fn(),
    },
  };
  registerLanService(luna, '/tmp/uploads', 'app1');
  return methods;
}

beforeEach(() => {
  startServerMock.mockReset();
  startServerMock.mockResolvedValue({ server: { close: vi.fn() }, port: 8890, localToken: '1'.repeat(64), unlockUploads: vi.fn() });
});

describe('Luna service access', () => {
  it('rejects other and unidentified callers without disclosing the private token', async () => {
    const methods = service();
    await Promise.resolve();
    for (const sender of [undefined, 'app2']) {
      for (const name of ['start', 'stop', 'heartbeat', 'serviceEvents']) {
        const respond = vi.fn();
        methods[name]({ sender, respond, payload: { appId: 'app1' } });
        expect(respond).toHaveBeenCalledWith({ returnValue: false, errorText: 'Local access only' });
        expect(JSON.stringify(respond.mock.calls)).not.toContain('1'.repeat(64));
      }
    }
  });

  it('delivers access only to the owning app, including pending cold starts', async () => {
    const methods = service();
    const respond = vi.fn();
    methods.start({ sender: 'app1', respond, payload: { encryptionKey: '1'.repeat(43) + '=' } });
    expect(respond).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(respond).toHaveBeenCalledWith({ running: true, port: 8890, localToken: '1'.repeat(64) });
    respond.mockClear();
    methods.start({ sender: 'app1', respond, payload: { encryptionKey: '1'.repeat(43) + '=' } });
    expect(respond).toHaveBeenCalledWith({ running: true, port: 8890, localToken: '1'.repeat(64) });
  });
});
