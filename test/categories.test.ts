import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, isWithin, levelOf } from "../src/domain/categories.ts";

test("normalizePath produces fixed-width, dot-terminated paths", () => {
  assert.equal(normalizePath("105"), "0105.");
  assert.equal(normalizePath("105.04"), "0105.0004.");
  assert.equal(normalizePath("105.04.03"), "0105.0004.0003.");
});

test("prefix containment: a parent grant covers descendants", () => {
  assert.ok(isWithin("105.04.03", "105"));
  assert.ok(isWithin("105.04", "105"));
  assert.ok(isWithin("105", "105")); // equal is within
});

test("containment does not spuriously match sibling prefixes", () => {
  // "105" must NOT be considered within "1" or "10", and "1050" must not match "105".
  assert.equal(isWithin("1050", "105"), false);
  assert.equal(isWithin("200", "105"), false);
  assert.equal(isWithin("105", "105.04"), false); // parent is not within child
});

test("level counting and bounds", () => {
  assert.equal(levelOf("105.04.03"), 3);
  assert.throws(() => normalizePath("1.2.3.4.5"), /1–4 levels/);
  assert.throws(() => normalizePath("10a"), /numeric/);
  assert.throws(() => normalizePath("12345"), /exceeds 4 digits/);
});
