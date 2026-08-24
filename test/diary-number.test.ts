import { test } from "node:test";
import assert from "node:assert/strict";
import { setupDb, NOW } from "./helpers.ts";
import { allocateDiaryNumber, formatDiaryNumber } from "../src/domain/diary-number.ts";
import { SqliteDialect } from "../src/db/dialect.ts";
import { PERMIT_REGISTRY } from "../src/config/sample-registry.ts";

const fmt = PERMIT_REGISTRY.diary;

test("formatDiaryNumber pads and joins REGISTRY/YEAR/NUMBER", () => {
  assert.equal(formatDiaryNumber(fmt, 2026, 142), "PERMIT/2026/00142");
});

test("allocation is gapless and sequential within a registry+year", async () => {
  const db = await setupDb();
  const got: string[] = [];
  for (let i = 0; i < 5; i++) {
    await db.transaction(async (tx) => {
      got.push((await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2026)).diaryNumber);
    });
  }
  assert.deepEqual(got, [
    "PERMIT/2026/00001",
    "PERMIT/2026/00002",
    "PERMIT/2026/00003",
    "PERMIT/2026/00004",
    "PERMIT/2026/00005",
  ]);
  db.close();
});

test("counters are independent per year and per registry", async () => {
  const db = await setupDb();
  let a = "", b = "";
  await db.transaction(async (tx) => { a = (await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2026)).diaryNumber; });
  await db.transaction(async (tx) => { b = (await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2027)).diaryNumber; });
  assert.equal(a, "PERMIT/2026/00001");
  assert.equal(b, "PERMIT/2027/00001");
  db.close();
});

test("a rolled-back transaction does not consume a number", async () => {
  const db = await setupDb();
  await db.transaction(async (tx) => { await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2026); }); // -> 1
  await assert.rejects(async () => {
    await db.transaction(async (tx) => {
      await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2026); // would be 2, but we abort
      throw new Error("abort");
    });
  });
  let next = "";
  await db.transaction(async (tx) => { next = (await allocateDiaryNumber(tx, SqliteDialect, fmt, "permit", 2026)).diaryNumber; });
  // Number 2 is reused because the aborted allocation was rolled back — gapless.
  assert.equal(next, "PERMIT/2026/00002");
  db.close();
});
