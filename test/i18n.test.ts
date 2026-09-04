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

test("programmatically rendered portal chrome uses explicit translations", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const key of [
    "customer.title", "customer.subtitle", "customer.switchHint",
    "worker.title", "worker.subtitle", "worker.switchHint",
    "publishing.title", "publishing.subtitle", "management.title", "management.subtitle",
    "table.diary", "table.category", "table.state", "case.history",
  ]) {
    assert.match(app, new RegExp(`\\bt\\("${key.replaceAll(".", "\\.")}\"\\)`));
  }
});

test("cancelling one self-contained editor only restores its own list", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /const showList = \(\) => card\.replaceWith\(renderCard\(\)\)/);
  assert.doesNotMatch(app, /const showList = \(\) => reManage\(\)/);
});

test("portal form chooser consumes split forms and includes the both audience", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /\.\.\.\(m\.operationForms \|\| \[\]\)\.map\(\(form\) => \(\{ \.\.\.form, kind: "operation" \}\)\)/);
  assert.match(app, /form\.audience === "worker" \|\| form\.audience === "both"/);
  assert.match(app, /form\.audience === "customer" \|\| form\.audience === "both"/);
});

test("operation schemas have a structured management editor and structured detail values", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function schemaPropertyRow\(/);
  assert.match(app, /"data-schema-required": true/);
  assert.doesNotMatch(app, /data-schema-nullable/);
  assert.match(app, /"data-schema-minimum": true/);
  assert.match(app, /"data-schema-pattern": true/);
  assert.match(app, /class: "schema-primary"/);
  assert.match(app, /class: "schema-validation"/);
  assert.match(app, /class: "schema-actions"/);
  assert.match(app, /row\.querySelector\("\.schema-message"\)\.hidden = !supportsNumberValidation && !supportsStringValidation/);
  assert.match(app, /supportsNumberValidation \? row\.querySelector\("\[data-schema-minimum\]"\)\.value : ""/);
  assert.match(app, /body\.propertySchema = \{ type: "object", properties, required, additionalProperties: false \}/);
  assert.match(app, /class: "operation-properties"/);
});

test("dynamic schema validation and all toasts are visibly positioned", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.schema-property \[hidden\] \{ display: none; \}/);
  assert.match(app, /input\.addEventListener\("blur", validate\)/);
  assert.match(app, /status\.className = message \? "validation-error"/);
  assert.match(styles, /\.toast \{ position: fixed; left: 50%; bottom: 24px; transform: translateX\(-50%\);/);
  assert.match(styles, /\.field \[aria-invalid="true"\]/);
});

test("locale storage failures are isolated from application startup", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function readStoredLocale\(\) \{\s*try \{ return localStorage\.getItem\("locale"\); \}\s*catch \{ return null; \}/);
  assert.match(app, /stored: readStoredLocale\(\)/);
});
