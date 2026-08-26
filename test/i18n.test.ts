import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createI18n, normalizeLocale, resolveLocale } from "../public/i18n.js";
import * as fi from "../public/locales/fi.js";

test("Finnish is the default and the only currently supported locale", () => {
  assert.equal(resolveLocale(), "fi");
  assert.equal(resolveLocale({ query: "?lang=sv", stored: "en", languages: ["de"] }), "fi");
  assert.equal(resolveLocale({ languages: ["fi-FI"] }), "fi");
  assert.equal(normalizeLocale("FI_fi"), "fi-FI");
  assert.equal(normalizeLocale("not_a_locale_!"), null);
});

test("explicit URL locale has precedence over stored and browser locales", () => {
  assert.equal(resolveLocale({ query: "?lang=fi", stored: "sv", languages: ["en"] }), "fi");
});

test("catalog translates semantic keys and named parameters", () => {
  const missing: string[] = [];
  const i18n = createI18n("fi", fi, (key) => missing.push(key));
  assert.equal(i18n.t("customer.initialState", { state: "Vastaanotettu" }), "Asian alkutila: Vastaanotettu");
  assert.equal(i18n.fromSource("Customer portal"), "Asiointi");
  assert.equal(i18n.t("missing.key"), "missing.key");
  assert.deepEqual(missing, ["missing.key"]);
});

test("all static document and programmatic translation keys exist in Finnish", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const keys = [
    ...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g),
    ...app.matchAll(/\bt\("([^"]+)"/g),
  ].map((match) => match[1]).filter((key): key is string => key !== undefined);
  const missing = [...new Set(keys)].filter((key) => !(key in fi.messages));
  assert.deepEqual(missing, []);
  assert.equal(Object.values(fi.sourceKeys).every((key) => key in fi.messages), true);
});

test("dynamic DOM children are not implicitly translated", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /document\.createTextNode\(String\(kid\)\)/);
  assert.doesNotMatch(app, /document\.createTextNode\(ts\(String\(kid\)\)\)/);
  assert.match(app, /t\("common\.open"\)/);
});

test("locale storage failures are isolated from application startup", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function readStoredLocale\(\) \{\s*try \{ return localStorage\.getItem\("locale"\); \}\s*catch \{ return null; \}/);
  assert.match(app, /stored: readStoredLocale\(\)/);
});
