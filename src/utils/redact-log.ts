/**
 * Redact secret-bearing diagnostic data before it reaches the debug console.
 * Deliberately hide entire URLs: Xtream credentials can occur in arbitrary
 * path segments, queries, URL userinfo, and provider-defined formats.
 */
const URL_IN_TEXT = /\b(?:https?|rtsp):\/\/[^\s<>"'`]+/gi;
const CREDENTIAL_ASSIGNMENT = /\b(password|passwd|username|token|api[_-]?key|authorization|secret)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;}]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;
const SECRET_PROPERTY = /password|passwd|username|token|api[_-]?key|authorization|secret|\burl\b|uri|headers/i;

export function redactLogString(input: string): string {
  return input
    .replace(URL_IN_TEXT, '[URL REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, (_whole, name: string) => `${name}=[REDACTED]`);
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[OBJECT HIDDEN]';
  if (value instanceof Error) {
    const cleanName = redactLogString(value.name);
    const cleanMessage = redactLogString(value.message);
    const cleanStack = value.stack ? redactLogString(value.stack) : value.stack;
    // Keep ordinary Errors intact so diagnostics and test identity checks work.
    // Errors with custom fields/cause may themselves contain secrets, so
    // sanitize them even if message/stack alone look harmless.
    const additionalKeys = Object.getOwnPropertyNames(value)
      .filter(key => key !== 'name' && key !== 'message' && key !== 'stack');
    if (cleanName === value.name && cleanMessage === value.message && cleanStack === value.stack
        && additionalKeys.length === 0) return value;
    const sanitized: Record<string, unknown> = {
      name: cleanName, message: cleanMessage, stack: cleanStack,
    };
    for (const key of additionalKeys) {
      if (SECRET_PROPERTY.test(key)) sanitized[key] = '[REDACTED]';
      else {
        try {
          sanitized[key] = redactLogValue((value as unknown as Record<string, unknown>)[key], depth + 1);
        } catch { sanitized[key] = '[UNAVAILABLE]'; }
      }
    }
    return sanitized;
  }
  if (Array.isArray(value)) return value.map(item => redactLogValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (SECRET_PROPERTY.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      try {
        result[key] = redactLogValue((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[key] = '[UNAVAILABLE]';
      }
    }
  }
  return result;
}
