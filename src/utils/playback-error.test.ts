import { describe, expect, it } from 'vitest';
import { nativePlaybackError, playbackErrorDetail, safePlaybackDetail } from './playback-error';

describe('playback error details', () => {
  it('preserves a native error code and decoder message', () => {
    expect(nativePlaybackError({ code: 3, message: 'Decoder failed (17)' } as MediaError))
      .toBe('MEDIA_ERR_DECODE | code=3 | Decoder failed (17)');
  });

  it('preserves player identifiers and HTTP status without inferring a cause', () => {
    expect(playbackErrorDetail('Player 1', {
      type: 'networkError', details: 'manifestLoadError', httpStatus: 403,
    })).toBe('Player 1 | networkError | manifestLoadError | HTTP 403');
    expect(playbackErrorDetail('Player 1', { httpStatus: 0 })).not.toContain('HTTP');
  });

  it('hides credential URLs, relative Xtream paths, and credential assignments', () => {
    const message = 'HTTP 401 http://host/live/u1/p1/1.ts token=secret1 /live/u2/p2/2.ts username=u3 password=p3';
    const detail = safePlaybackDetail(message);
    expect(detail).toContain('HTTP 401');
    for (const secret of ['http://host', 'u1', 'p1', 'u2', 'p2', 'u3', 'p3', 'secret1']) {
      expect(detail).not.toContain(secret);
    }
  });

  it('bounds long engine messages and removes control characters', () => {
    expect(safePlaybackDetail('a\u0000\nb')).toBe('a  b');
    expect(safePlaybackDetail('a'.repeat(1000))).toHaveLength(600);
  });

  it('states when a native player provides no details', () => {
    expect(nativePlaybackError(null)).toBe('The player did not provide additional error details.');
  });
});
