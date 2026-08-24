/**
 * Small logging boundary for application code.
 *
 * Customer data must be supplied through `customerData`, never interpolated
 * into the message or metadata. It is omitted unless an operator explicitly
 * enables redaction, and is never emitted verbatim.
 */

export type LogLevel = "info" | "error";
export type LogValue = string | number | boolean | null;

export interface LogDetails {
  /** Operational, non-customer fields safe to send to the configured sink. */
  readonly metadata?: Readonly<Record<string, LogValue>>;
  /** Customer fields: omitted by default or redacted when explicitly enabled. */
  readonly customerData?: Readonly<Record<string, LogValue>>;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, LogValue>>;
  readonly customerData?: Readonly<Record<string, string>>;
}

/** Implement this interface to forward entries to an external logging service. */
export interface LogSink {
  write(entry: LogEntry): void;
}

export interface Logger {
  info(message: string, details?: LogDetails): void;
  error(message: string, details?: LogDetails): void;
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  /** `omit` is deliberately the default and cannot expose customer data. */
  readonly customerDataHandling?: "omit" | "redact";
  /** Characters preserved before `[REDACTED]`; used only in redact mode. */
  readonly redactionPrefixLength?: number;
}

export const consoleLogSink: LogSink = {
  write(entry) {
    const output = entry.metadata || entry.customerData
      ? `${entry.message} ${JSON.stringify({ ...entry.metadata, ...entry.customerData })}`
      : entry.message;
    if (entry.level === "error") console.error(output);
    else console.log(output);
  },
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleLogSink;
  const handling = options.customerDataHandling ?? "omit";
  const prefixLength = options.redactionPrefixLength ?? 0;
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0) {
    throw new Error("redactionPrefixLength must be a non-negative integer");
  }

  const write = (level: LogLevel, message: string, details?: LogDetails): void => {
    const customerData = handling === "redact" && details?.customerData
      ? Object.fromEntries(Object.entries(details.customerData).map(([key, value]) => [key, redact(value, prefixLength)]))
      : undefined;
    sink.write({
      level,
      message,
      ...(details?.metadata ? { metadata: details.metadata } : {}),
      ...(customerData ? { customerData } : {}),
    });
  };

  return {
    info: (message, details) => write("info", message, details),
    error: (message, details) => write("error", message, details),
  };
}

function redact(value: LogValue, prefixLength: number): string {
  const text = String(value);
  return `${text.slice(0, prefixLength)}[REDACTED]`;
}
