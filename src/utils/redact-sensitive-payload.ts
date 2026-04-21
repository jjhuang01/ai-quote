const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|token|secret|authorization|cookie|api[-_]?key|session|auth)/i;

function redactString(value: string): string {
  if (value.length <= 4) {
    return '***';
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***${value.slice(-1)}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}

export function redactSensitivePayload<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item)) as T;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, childValue]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          if (typeof childValue === 'string') {
            return [key, redactString(childValue)];
          }
          return [key, '[REDACTED]'];
        }
        return [key, redactSensitivePayload(childValue)];
      },
    );
    return Object.fromEntries(entries) as T;
  }

  return value;
}
