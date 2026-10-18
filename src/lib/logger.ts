type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  /** Exact values (secrets from env) scrubbed from every string, wherever they appear. */
  secretValues?: readonly string[];
  /** Time source; logs carry no timestamp without one (business time comes from `clock`). */
  now?: () => string;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /pass(word)?|secret|token|cookie|authorization|e-?mail|phone|totp|otp|recovery|api[-_]?key|private[-_]?key|session/i;

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join(REDACTED) : out), text);
}

function sanitize(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrub(value, secrets);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message, secrets),
      stack: value.stack && scrub(value.stack, secrets),
    };
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, seen));

  const out: Fields = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(inner, secrets, seen);
  }
  return out;
}

/** Structured JSON logger: one line per entry, sensitive keys and registered secret values redacted. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const secrets = (options.secretValues ?? []).filter((s) => s.length >= 4);

  const log = (level: Level, msg: string, fields: Fields = {}) => {
    const entry = {
      ...(options.now ? { ts: options.now() } : {}),
      level,
      msg: scrub(msg, secrets),
      ...(sanitize(fields, secrets, new WeakSet()) as Fields),
    };
    write(JSON.stringify(entry));
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}
