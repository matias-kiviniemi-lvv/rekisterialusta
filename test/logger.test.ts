import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, type LogEntry, type LogSink } from "../src/logging/logger.ts";

function recordingSink(entries: LogEntry[]): LogSink {
  return { write: (entry) => entries.push(entry) };
}

test("logger omits customer data by default", () => {
  const entries: LogEntry[] = [];
  const logger = createLogger({ sink: recordingSink(entries) });

  logger.info("case opened", {
    metadata: { registryId: "permit" },
    customerData: { customerId: "customer-123", name: "Citizen One" },
  });

  assert.deepEqual(entries, [{
    level: "info",
    message: "case opened",
    metadata: { registryId: "permit" },
  }]);
});

test("logger can retain a configured prefix but never emits customer data verbatim", () => {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    sink: recordingSink(entries),
    customerDataHandling: "redact",
    redactionPrefixLength: 3,
  });

  logger.error("delivery failed", { customerData: { customerId: "customer-123", attempts: 2 } });

  assert.deepEqual(entries[0]?.customerData, {
    customerId: "cus[REDACTED]",
    attempts: "2[REDACTED]",
  });
});

test("logger rejects invalid redaction prefix lengths", () => {
  assert.throws(() => createLogger({ redactionPrefixLength: -1 }), /non-negative integer/);
  assert.throws(() => createLogger({ redactionPrefixLength: 1.5 }), /non-negative integer/);
});
