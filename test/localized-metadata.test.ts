import assert from "node:assert/strict";
import test from "node:test";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { resolveLocalizedText, validateLocaleConfig, validateLocalizedText } from "../src/config/localization.ts";
import { exportRegistryConfig } from "../src/services/config-promote.ts";

const NOW = "2026-08-26T00:00:00.000Z";

test("localized values validate BCP 47 keys, Finnish coverage, and deterministic source fallback", () => {
  validateLocaleConfig({ supported: ["fi", "sv"], default: "fi" });
  assert.throws(() => validateLocaleConfig({ supported: ["fi", "FI"], default: "fi" }), /duplicates/);
  assert.throws(() => validateLocalizedText({ sourceLocale: "sv", values: { sv: "Namn" } }, "name"), /Finnish/);
  const value = { sourceLocale: "fi", values: { fi: "Nimi", sv: "Namn" } };
  assert.deepEqual(resolveLocalizedText(value, "legacy", "sv-FI"), { value: "Namn", locale: "sv", fallback: true });
  assert.deepEqual(resolveLocalizedText(value, "legacy", "en"), { value: "Nimi", locale: "fi", fallback: true });
});

test("registry list and metadata expose resolved Finnish labels while retaining stable IDs", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const list = await dispatch(platform, { method: "GET", url: "/api/registries?lang=fi", body: undefined });
  assert.equal(list.headers?.["Content-Language"], "fi");
  assert.equal(list.headers?.Vary, "Accept-Language");
  const registries = (list.body as { registries: Array<{ registryId: string; name: string }> }).registries;
  assert.deepEqual(registries.map(({ registryId, name }) => ({ registryId, name })), [
    { registryId: "permit", name: "Luparekisteri" }, { registryId: "grant", name: "Avustusrekisteri" },
  ]);

  const response = await dispatch(platform, { method: "GET", url: "/api/registries/permit/meta?lang=fi", authorization: "Bearer customer:c-1", body: undefined });
  const meta = response.body as { locale: string; fields: Array<{ name: string; label: string }>; states: Array<{ id: string; name: string }> };
  assert.equal(meta.locale, "fi");
  assert.deepEqual(meta.fields.find((field) => field.name === "applicant_name"), { name: "applicant_name", type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, label: "Hakijan nimi" });
  assert.equal(meta.states.find((state) => state.id === "received")?.name, "Vastaanotettu");
});

test("complete translations are admin-only and promotion artifacts retain localized metadata", async () => {
  const { platform, shared } = await buildSamplePlatform(fixedClock(NOW));
  const denied = await dispatch(platform, { method: "GET", url: "/api/registries/permit/meta?include=translations", authorization: "Bearer customer:c-1", body: undefined });
  assert.equal(denied.status, 403);
  const allowed = await dispatch(platform, { method: "GET", url: "/api/registries/permit/meta?include=translations", authorization: "Bearer worker:w-admin", body: undefined });
  assert.equal(allowed.status, 200);
  const artifact = await exportRegistryConfig(shared, "permit");
  assert.equal(artifact?.labels?.values.fi, "Luparekisteri");
  assert.equal(artifact?.fields[0]?.labels?.values.fi, "Hakijan nimi");
});
