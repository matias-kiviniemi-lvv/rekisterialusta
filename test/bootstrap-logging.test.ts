import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapFromEnv, fixedClock, type BootstrapLogger } from "../src/bootstrap.ts";

const NOW = "2026-08-20T12:00:00.000Z";

test("bootstrap logs database targets and migration progress", async () => {
  const savedDialect = process.env.DB_DIALECT;
  const savedDir = process.env.DB_DIR;
  const messages: string[] = [];
  const logger: BootstrapLogger = {
    info: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };

  try {
    delete process.env.DB_DIALECT;
    delete process.env.DB_DIR;
    const result = await bootstrapFromEnv(fixedClock(NOW), logger);
    await Promise.all([result.shared.close(), ...Object.values(result.dbs).map((db) => db.close())]);

    assert.ok(messages.some((message) => message.includes("Connecting shared database :memory:")));
    assert.ok(messages.some((message) => message.includes("Running shared database migrations")));
    assert.ok(messages.some((message) => message.includes("Shared migration: 0001 shared_schema: applying")));
    assert.ok(messages.some((message) => message.includes('Connecting registry "permit" database :memory:')));
    assert.ok(messages.some((message) => message.includes('Registry "permit" migration: 0002 registry_spine:permit: applying')));
    assert.ok(messages.some((message) => message.includes('Connecting registry "grant" database :memory:')));
    assert.ok(messages.some((message) => message.includes("Platform ready with 2 registries")));
  } finally {
    if (savedDialect === undefined) delete process.env.DB_DIALECT;
    else process.env.DB_DIALECT = savedDialect;
    if (savedDir === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = savedDir;
  }
});
