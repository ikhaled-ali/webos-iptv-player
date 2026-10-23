import { afterEach, describe, expect, it } from 'vitest';
import { serviceBase, serviceHeaders, setServicePort } from './service-http';

afterEach(() => setServicePort(null));

describe('private local service session', () => {
  it('requires both a valid port and a Luna-delivered token', () => {
    setServicePort(8890);
    expect(serviceBase()).toBeNull();
    setServicePort(8890, '1'.repeat(64));
    expect(serviceBase()).toBe('http://127.0.0.1:8890');
    expect(serviceHeaders()).toEqual({ 'X-IPTV-Local-Token': '1'.repeat(64) });
    setServicePort(8890, 'invalid');
    expect(serviceBase()).toBeNull();
    expect(serviceHeaders()['X-IPTV-Local-Token']).toBe('');
  });

  it('clears stale access when stopped or given an invalid port', () => {
    for (const port of [null, 0, 65536, 8890.5]) {
      setServicePort(8890, '1'.repeat(64));
      setServicePort(port, '2'.repeat(64));
      expect(serviceBase()).toBeNull();
      expect(serviceHeaders()['X-IPTV-Local-Token']).toBe('');
    }
  });
});
