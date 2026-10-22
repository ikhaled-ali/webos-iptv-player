import { describe, it, expect, vi } from 'vitest';
import { redactLogString, redactLogValue } from './redact-log';
import { createLogger } from './logger';

describe('credential-safe logger', () => {
  it('removes Xtream query credentials and URLs completely', () => {
    const input = 'EPG http://provider.test/xmltv.php?username=alice&password=SECRETPASS';
    const output = redactLogString(input);
    expect(output).not.toContain('SECRETPASS');
    expect(output).not.toContain('alice');
    expect(output).toContain('[URL REDACTED]');
  });
  it('removes password-bearing stream paths', () => {
    const output = redactLogString('http://host/live/alice/SECRETPASS/123.ts');
    expect(output).not.toContain('SECRETPASS');
    expect(output).not.toContain('alice');
  });
  it('redacts nested credentials and error messages', () => {
    const value = redactLogValue({
      auth: { password: 'SECRETPASS', apiKey: 'OTHERSECRET' },
      error: new Error('Request https://host/api?token=SECRET failed'),
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain('SECRETPASS');
    expect(text).not.toContain('OTHERSECRET');
    expect(text).not.toContain('SECRET failed');
    expect(text).not.toContain('https://host');
  });
  it('redacts plain assignments outside URLs', () => {
    expect(redactLogString('password=SECRETPASS')).toBe('password=[REDACTED]');
  });

  it.each([
    'Authorization: Bearer SYNTHETIC_SECRET',
    'Authorization: Basic SYNTHETIC_SECRET',
    '{"password":"SYNTHETIC_SECRET"}',
    "password='SYNTHETIC_SECRET with spaces'",
  ])('scrubs credential assignments through the logger: %s', input => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createLogger('Test').warn(input);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.stringify(output.mock.calls)).not.toContain('SYNTHETIC_SECRET');
      expect(JSON.stringify(output.mock.calls)).not.toContain('with spaces');
      expect(JSON.stringify(output.mock.calls)).toContain('[REDACTED]');
    } finally {
      output.mockRestore();
    }
  });

  it('bounds cyclic Error causes before reaching the stack limit', () => {
    const error = new Error('Request failed') as Error & { cause?: unknown };
    error.cause = error;
    const clean = redactLogValue(error) as { cause: { cause: { cause: { cause: unknown } } } };
    expect(clean.cause.cause.cause.cause).toBe('[OBJECT HIDDEN]');
  });

  it('redacts credentials in an Error name', () => {
    const error = new Error('Request failed');
    error.name = 'token=SYNTHETIC_SECRET';
    error.stack = 'Request failed';
    expect(JSON.stringify(redactLogValue(error))).not.toContain('SYNTHETIC_SECRET');
  });
});


describe('diagnostic Error identity', () => {
  it('keeps safe Error objects unchanged but scrubs errors carrying URLs', () => {
    const harmless = new Error('metadata read failed');
    expect(redactLogValue(harmless)).toBe(harmless);
    const sensitive = redactLogValue(new Error('GET https://test.invalid/api?password=secret'));
    expect(JSON.stringify(sensitive)).not.toContain('secret');
    expect(JSON.stringify(sensitive)).not.toContain('https://test.invalid');
    const wrapped = new Error('Request failed') as Error & { cause?: unknown };
    wrapped.cause = new Error('https://test.invalid/?token=secret');
    const sanitized = redactLogValue(wrapped);
    expect(JSON.stringify(sanitized)).not.toContain('secret');
    expect(JSON.stringify(sanitized)).not.toContain('https://test.invalid');
  });
});
