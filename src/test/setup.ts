import { beforeEach } from 'vitest';
import { DEFAULT_LOCALE, setLocale } from '../i18n';
import { Logger } from '../utils/logger';

// Keep production logging at 'warn'; the existing diagnostic tests
// intentionally assert debug/info events. Tests use fake credentials.
Logger.setLevel('debug');

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
});
