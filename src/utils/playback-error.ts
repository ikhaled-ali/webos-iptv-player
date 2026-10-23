import { t } from '../i18n';
import { redactLogString } from './redact-log';

interface PlaybackErrorFields {
  type?: unknown;
  details?: unknown;
  code?: unknown;
  category?: unknown;
  httpStatus?: unknown;
  message?: unknown;
}

export function safePlaybackDetail(value: string): string {
  return redactLogString(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"`]+/gi, '[URL REDACTED]')
    .replace(/(?:^|[\s("'])\/\/[^\s<>"')]+/g, ' [URL REDACTED]')
    .replace(/(?:^|[\s("'])\/(?:live|movie|series|timeshift)\/[^\s<>"')]+/gi, ' [URL REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim().slice(0, 600);
}

export function playbackErrorDetail(source: string, fields: PlaybackErrorFields = {}): string {
  const parts = [source];
  for (const value of [fields.type, fields.details]) {
    if (typeof value === 'string' && value) parts.push(safePlaybackDetail(value));
  }
  if (typeof fields.httpStatus === 'number' && fields.httpStatus >= 100 && fields.httpStatus <= 599) {
    parts.push(`HTTP ${fields.httpStatus}`);
  }
  for (const name of ['code', 'category'] as const) {
    const value = fields[name];
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${name}=${value}`);
  }
  const message = fields.message instanceof Error ? fields.message.message : fields.message;
  if (typeof message === 'string' && message) parts.push(safePlaybackDetail(message));
  return parts.join(' | ');
}

export function nativePlaybackError(error: MediaError | null): string {
  if (!error) return t('player.noErrorDetails');
  const names: Record<number, string> = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
  };
  return playbackErrorDetail(names[error.code] ?? 'MediaError', { code: error.code, message: error.message });
}
