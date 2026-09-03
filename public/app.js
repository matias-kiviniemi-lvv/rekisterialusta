"use strict";
import { createI18n, resolveLocale, translateDocument } from "./i18n.js";
import * as fiCatalog from "./locales/fi.js";
/*
 * Registry Platform — MVP console (vanilla JS, no build step).
 * Drives the REST API. "Acting as" chooses the stub-identity bearer so you can
 * watch the two auth systems and admin gating behave differently per role.
 */

function readStoredLocale() {
  try { return localStorage.getItem("locale"); }
  catch { return null; }
}

function storeLocale(value) {
  try { localStorage.setItem("locale", value); }
  catch { /* Locale persistence is optional (for example, in privacy-restricted contexts). */ }
}

const locale = resolveLocale({ query: location.search, stored: readStoredLocale(), languages: navigator.languages });
const i18n = createI18n(locale, fiCatalog, (key) => console.warn(`[i18n] missing translation: ${key}`));
const t = i18n.t;
const ts = i18n.fromSource;
translateDocument(document, i18n);
document.title = t("app.title");

const IDENTITIES = {
  "public": { label: "Public (anonymous)", bearer: null },
  "customer:c-1": { label: "Citizen One — customer", bearer: "customer:c-1" },
  "customer:c-2": { label: "Citizen Two — customer", bearer: "customer:c-2" },
  "worker:w-anna": { label: "Anna — worker (Environment 105)", bearer: "worker:w-anna" },
  "worker:w-bo": { label: "Bo — worker (Building 200)", bearer: "worker:w-bo" },
  "worker:w-cara": { label: "Cara — worker (Grants 300)", bearer: "worker:w-cara" },
  "worker:w-admin": { label: "Admin — worker (management)", bearer: "worker:w-admin" },
};

const state = {
  identity: "worker:w-anna",
  registry: null,
  meta: {},            // registryId -> meta
  tab: "customer",
  workerView: "assigned",
  mgmtSection: "fields", // active Management sub-tab
  customerCreating: false,
  open: { customer: null, worker: null, publishing: null },
};

// ---- tiny helpers ----------------------------------------------------------

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  // Callers translate known interface copy explicitly. Values from cases and
  // registry configuration must always be rendered exactly as received.
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const id = IDENTITIES[state.identity];
  const headers = {};
  if (id.bearer) headers["authorization"] = "Bearer " + id.bearer;
  const opts = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const url = new URL(path, location.origin);
  url.searchParams.set("lang", locale);
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

let toastTimer;
function toast(msg, kind) {
  const t = $("#toast");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}
function ok(r, okMsg) {
  if (r.status >= 200 && r.status < 300) { if (okMsg) toast(okMsg, "ok"); return true; }
  toast(`${r.status}: ${r.data && r.data.error ? r.data.error : t("error.requestFailed")}`, "err");
  return false;
}

function meta() { return state.meta[state.registry]; }
async function refreshMeta() {
  const r = await api("GET", `/api/registries/${state.registry}/meta`);
  if (r.status === 200) state.meta[state.registry] = r.data;
}
function stateBadge(m, stateId, isPublished) {
  const s = (m.states || []).find((x) => x.id === stateId) || { name: stateId };
  const cls = s.isWaitingForCustomer ? "waiting" : s.isOpen ? "open" : "closed";
  const els = [h("span", { class: "badge " + cls }, s.name || stateId)];
  if (isPublished) els.push(" ", h("span", { class: "badge property" }, t("status.published")));
  return els;
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  const language = $("#language");
  language.value = i18n.locale;
  language.addEventListener("change", () => {
    storeLocale(language.value);
    const url = new URL(location.href);
    url.searchParams.set("lang", language.value);
    location.assign(url);
  });
  const idSel = $("#identity");
  for (const [k, v] of Object.entries(IDENTITIES)) idSel.append(h("option", { value: k }, ts(v.label)));
  idSel.value = state.identity;
  idSel.addEventListener("change", async () => {
    state.identity = idSel.value;
    state.open = { customer: null, worker: null, publishing: null };
    await refreshMeta();
    render();
  });

  const r = await api("GET", "/api/registries");
  const regSel = $("#registry");
  for (const reg of r.data.registries) regSel.append(h("option", { value: reg.registryId }, `${reg.name} (${reg.diaryCode})`));
  state.registry = r.data.registries[0].registryId;
  regSel.value = state.registry;
  regSel.addEventListener("change", async () => { state.registry = regSel.value; state.open = { customer: null, worker: null, publishing: null }; await refreshMeta(); render(); });

  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn);
      render();
    });
  }
  await refreshMeta();
  render();
}

function render() {
  const v = $("#view");
  v.innerHTML = "";
  if (!meta()) { v.append(h("p", { class: "empty" }, t("common.loading"))); return; }
  ({ customer: renderCustomer, worker: renderWorker, publishing: renderPublishing, management: renderManagement }[state.tab])(v);
}

// ---- dynamic field inputs --------------------------------------------------

function fieldInput(f) {
  const name = f.name;
  if (f.type === "boolean") return h("select", { id: "f_" + name }, h("option", { value: "false" }, "false"), h("option", { value: "true" }, "true"));
  const type = f.type === "integer" ? "number" : f.type === "decimal" ? "number" : f.type === "date" ? "date" : "text";
  const attrs = { id: "f_" + name, type };
  if (f.type === "integer") attrs.step = "1";
  if (f.type === "decimal") attrs.step = "any";
  return h("input", attrs);
}
function readField(f) {
  const el = $("#f_" + f.name);
  if (!el) return undefined;
  const raw = el.value;
  if (raw === "" && f.nullable) return null;
  if (f.type === "boolean") return raw === "true";
  if (f.type === "integer" || f.type === "decimal") return raw === "" ? null : Number(raw);
  return raw;
}

// ---- Customer portal -------------------------------------------------------

async function renderCustomer(v) {
  const m = meta();
  v.innerHTML = "";
  v.append(h("h2", null, t("customer.title")), h("p", { class: "sub" }, t("customer.subtitle")));
  if (!state.identity.startsWith("customer:")) {
    v.append(h("div", { class: "hint" }, t("customer.switchHint")));
  }

  const listCard = h("div", { class: "card" }, h("h3", null, t("customer.myCases")));
  v.append(listCard);
  if (state.customerCreating) { showNewCaseForm(listCard); return; }
  const r = await api("GET", `/api/registries/${state.registry}/my-cases`);
  if (r.status !== 200) { listCard.append(h("div", { class: "hint" }, t("customer.signInHint"))); }
  else if (!r.data.cases.length) listCard.append(h("div", { class: "empty" }, t("customer.empty")));
  else listCard.append(caseTable(m, r.data.cases, (c) => { state.open.customer = c.diaryNumber; renderCustomer(v).catch(console.error); }));
  listCard.append(h("div", { class: "list-actions inline" },
    h("button", { class: "btn", onclick: () => { state.customerCreating = true; renderCustomer(v); } }, t("customer.start")),
    h("button", { class: "btn ghost", onclick: () => renderCustomer(v) }, t("common.refresh"))));

  if (state.open.customer) v.append(await caseDetailCard("customer", state.open.customer));
}

function showNewCaseForm(v) {
  const m = meta();
  const initial = m.states[0];
  const form = h("div", { class: "list-form" },
    h("h3", null, t("customer.newTitle")),
    h("div", { class: "field" }, h("label", null, t("field.category")), categorySelect()),
    ...m.fields.map((f) => h("div", { class: "field" },
      h("label", null, f.name, f.nullable ? "" : h("span", { class: "req" }, " *")), fieldInput(f))),
    h("p", { class: "sub" }, t("customer.initialState", { state: initial.name })),
    h("div", { class: "inline" }, h("button", { class: "btn", onclick: async () => {
      const fields = {};
      for (const f of m.fields) { const val = readField(f); if (val !== undefined && val !== null) fields[f.name] = val; }
      const r = await api("POST", `/api/registries/${state.registry}/cases`, { category: $("#cat_sel").value, initialState: initial.id, fields });
      if (ok(r, t("customer.created", { diary: r.data.diaryNumber }))) { state.customerCreating = false; state.open.customer = r.data.diaryNumber; renderCustomer($("#view")); }
    } }, t("customer.create")),
    h("button", { class: "btn ghost", onclick: () => { state.customerCreating = false; renderCustomer($("#view")); } }, t("common.cancel"))));
  v.append(form);
}

// ---- Worker portal ---------------------------------------------------------

async function renderWorker(v) {
  const m = meta();
  v.innerHTML = "";
  v.append(h("h2", null, t("worker.title")), h("p", { class: "sub" }, t("worker.subtitle")));
  if (!state.identity.startsWith("worker:")) v.append(h("div", { class: "hint" }, t("worker.switchHint")));

  const views = [["assigned", "Assigned to me"], ["unassigned", "Unassigned (opted-in)"], ["authorized", "All authorized"]];
  const pills = h("div", { class: "pillbar" }, ...views.map(([k, label]) =>
    h("button", { class: state.workerView === k ? "active" : "", onclick: () => { state.workerView = k; renderWorker(v); } }, ts(label))));
  const listCard = h("div", { class: "card" });
  listCard.append(h("div", { class: "list-filters" }, pills));
  v.append(listCard);
  const r = await api("GET", `/api/registries/${state.registry}/worker/cases?view=${state.workerView}`);
  if (r.status !== 200) listCard.append(h("div", { class: "hint" }, t("worker.authRequired")));
  else if (!r.data.cases.length) listCard.append(h("div", { class: "empty" }, t("worker.empty")));
  else {
    const extra = state.workerView === "unassigned"
      ? { header: "", cell: (c) => h("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); const a = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/assign`, {}); if (ok(a, t("worker.assignedToast"))) renderWorker(v); } }, t("worker.assign")) }
      : null;
    listCard.append(caseTable(m, r.data.cases, (c) => { state.open.worker = c.diaryNumber; renderWorker(v); }, extra));
  }

  // Pending approvals.
  const pend = await api("GET", `/api/registries/${state.registry}/worker/pending`);
  if (pend.status === 200 && pend.data.pending.length) {
    const card = h("div", { class: "card" }, h("h3", null, t("worker.pending")));
    const table = h("table", null, h("thead", null, h("tr", null, h("th", null, "Case"), h("th", null, "Form"), h("th", null, "Proposed"), h("th", null, ""))));
    const tb = h("tbody");
    for (const p of pend.data.pending) {
      tb.append(h("tr", null,
        h("td", { class: "mono" }, p.diaryNumber),
        h("td", null, p.formId),
        h("td", { class: "mono" }, JSON.stringify(p.payload)),
        h("td", { class: "inline" },
          h("button", { class: "btn sm", onclick: async () => { const a = await api("POST", `/api/registries/${state.registry}/pending/${p.pendingId}/approve`, {}); if (ok(a, t("worker.approved"))) renderWorker(v); } }, t("worker.approve")),
          h("button", { class: "btn sm danger", onclick: async () => { const a = await api("POST", `/api/registries/${state.registry}/pending/${p.pendingId}/reject`, {}); if (ok(a, t("worker.rejected"))) renderWorker(v); } }, t("worker.reject")))));
    }
    table.append(tb); card.append(table); v.append(card);
  }

  if (state.open.worker) v.append(await caseDetailCard("worker", state.open.worker));
}

// ---- Publishing portal -----------------------------------------------------

async function renderPublishing(v, newSearch = false) {
  const m = meta();
  const keepCat = $("#pub_cat") ? $("#pub_cat").value : "";
  const keepQuery = $("#pub_query") ? $("#pub_query").value : "";
  const keepScope = $("#pub_scope") ? $("#pub_scope").value : "registry";
  if (newSearch) state.open.publishing = null;
  v.innerHTML = "";
  v.append(h("h2", null, t("publishing.title")), h("p", { class: "sub" }, t("publishing.subtitle")));
  const queryInput = h("input", { id: "pub_query", placeholder: t("publishing.queryPlaceholder"), style: "min-width:280px", value: keepQuery });
  const catInput = h("input", { id: "pub_cat", placeholder: t("publishing.categoryPlaceholder"), style: "max-width:220px", value: keepCat });
  const scope = h("select", { id: "pub_scope" }, h("option", { value: "registry" }, t("publishing.currentRegistry")), h("option", { value: "all" }, t("publishing.allRegistries")));
  scope.value = keepScope;
  const filters = h("form", {
    class: "inline",
    onsubmit: (event) => { event.preventDefault(); renderPublishing(v, true); },
  }, queryInput, catInput, scope, h("button", { class: "btn", type: "submit" }, t("publishing.search")));
  const card = h("div", { class: "card" }, h("h3", null, t("publishing.results")));
  card.append(h("div", { class: "list-filters" }, filters));
  v.append(card);
  const params = new URLSearchParams();
  if (keepQuery) params.set("q", keepQuery);
  if (keepCat) params.set("category", keepCat);
  const path = keepScope === "all" ? "/api/published/search" : `/api/registries/${state.registry}/published`;
  const r = await api("GET", `${path}?${params}`);
  if (!ok(r)) { card.append(h("div", { class: "empty" }, r.data.error)); return; }
  if (!r.data.cases.length) card.append(h("div", { class: "empty" }, t("publishing.empty")));
  else card.append(caseTable(m, r.data.cases, async (c) => {
    if (c.registryId && c.registryId !== state.registry) {
      state.registry = c.registryId;
      $("#registry").value = c.registryId;
      await refreshMeta();
    }
    state.open.publishing = c.diaryNumber;
    renderPublishing(v);
  }, keepScope === "all" ? { header: "Registry", cell: (c) => c.registryId } : undefined));
  if (state.open.publishing) v.append(await caseDetailCard("publishing", state.open.publishing));
}

// ---- Management portal ------------------------------------------------------

const MGMT_SECTIONS = [
  ["fields", "Fields"],
  ["states", "States"],
  ["transitions", "Transitions"],
  ["categories", "Categories"],
  ["forms", "Forms"],
  ["rules", "Rules"],
  ["authorizations", "Authorizations"],
  ["tokens", "Tokens"],
  ["config", "Config versions"],
  ["exports", "Exports"],
];

async function renderManagement(v) {
  const m = meta();
  v.innerHTML = "";
  v.append(h("h2", null, t("management.title")), h("p", { class: "sub" }, t("management.subtitle")));
  if (state.identity !== "worker:w-admin") v.append(h("div", { class: "hint" }, t("management.switchHint")));

  // Sub-tab navigation — one section per managed resource type.
  const nav = h("div", { class: "pillbar subnav" }, ...MGMT_SECTIONS.map(([key, label]) =>
    h("button", { class: state.mgmtSection === key ? "active" : "", onclick: () => { state.mgmtSection = key; renderManagement(v); } }, ts(label))));
  v.append(nav);

  const body = h("div", { class: "mgmt-body" });
  v.append(body);
  const section = MGMT_RENDERERS[state.mgmtSection] || MGMT_RENDERERS.fields;
  await section(body, m);
}

// Re-render the currently active Management section (after a create).
function reManage() { renderManagement($("#view")).catch(console.error); }

const MGMT_RENDERERS = {
  async fields(body, m) {
    selfContainedList(body, t("management.currentFields"), [
      { header: t("management.name"), cls: "mono", get: (f) => f.name },
      { header: t("management.type"), get: (f) => f.type },
      { header: t("management.nullable"), get: (f) => f.nullable ? t("common.yes") : t("common.no") },
    ], m.fields, t("management.noFields"), t("management.addField"), (cancel) => manageCard(t("management.addStatutoryField"), [
      ["name", h("input", { id: "af_name", placeholder: "e.g. coordinate" })],
      ["type", h("select", { id: "af_type" }, ...["text", "integer", "decimal", "date", "boolean"].map((t) => h("option", null, t)))],
      ["nullable", h("select", { id: "af_null" }, h("option", { value: "true" }, "true"), h("option", { value: "false" }, "false"))],
      ["writable on create", h("select", { id: "af_create" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "yes"))],
      ["writable on update", h("select", { id: "af_update" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "yes"))],
      ["publication eligible", h("select", { id: "af_publish" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "yes"))],
      ["legal basis", h("input", { id: "af_basis", placeholder: "statute or mandate" })],
      ["purpose", h("input", { id: "af_purpose", placeholder: "why this value is processed" })],
      ["sensitivity", h("select", { id: "af_sensitivity" }, ...["normal", "public", "sensitive", "restricted"].map((v) => h("option", { value: v }, v)))],
      ["retention policy", h("input", { id: "af_retention", placeholder: "policy identifier" })],
    ], async () => {
      const r = await api("POST", `/api/admin/registries/${state.registry}/fields`, {
        name: $("#af_name").value, type: $("#af_type").value, nullable: $("#af_null").value === "true",
        writableOnCreate: $("#af_create").value === "true", writableOnUpdate: $("#af_update").value === "true",
        publicationEligible: $("#af_publish").value === "true", legalBasis: $("#af_basis").value,
        purpose: $("#af_purpose").value, sensitivity: $("#af_sensitivity").value,
        retentionPolicy: $("#af_retention").value,
      });
      if (ok(r, `Field added → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
    }, "Add field (schema migration)", cancel));
  },

  async states(body, m) {
    selfContainedList(body, t("management.currentStates"), [
      { header: "ID", cls: "mono", get: (s) => s.id },
      { header: t("management.name"), get: (s) => s.name },
      { header: t("management.open"), get: (s) => s.isOpen ? t("management.openValue") : t("management.closedValue") },
      { header: t("management.waiting"), get: (s) => s.isWaitingForCustomer ? t("management.waitingValue") : "—" },
    ], m.states, t("management.noStates"), t("management.addState"), (cancel) => manageCard(t("management.addState"), [
      ["id", h("input", { id: "as_id", placeholder: "e.g. appealed" })],
      ["name", h("input", { id: "as_name", placeholder: "Appealed" })],
      ["open", h("select", { id: "as_open" }, h("option", { value: "true" }, "open"), h("option", { value: "false" }, "closed"))],
      ["waiting", h("select", { id: "as_wait" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "waiting for customer"))],
    ], async () => {
      const r = await api("POST", `/api/admin/registries/${state.registry}/states`, { id: $("#as_id").value, name: $("#as_name").value, isOpen: $("#as_open").value === "true", isWaitingForCustomer: $("#as_wait").value === "true" });
      if (ok(r, `State added → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
    }, "Add state", cancel));
  },

  async transitions(body, m) {
    const nameOf = (id) => (m.states.find((x) => x.id === id) || {}).name || id;
    selfContainedList(body, t("management.currentTransitions"), [
      { header: t("management.from"), get: (t) => nameOf(t.from) },
      { header: "", get: () => "→" },
      { header: t("management.to"), get: (t) => nameOf(t.to) },
    ], m.transitions, t("management.noTransitions"), t("management.addTransition"), (cancel) => manageCard(t("management.addTransition"), [
      ["from", stateSelect("at_from")],
      ["to", stateSelect("at_to")],
    ], async () => {
      const r = await api("POST", `/api/admin/registries/${state.registry}/transitions`, { from: $("#at_from").value, to: $("#at_to").value });
      if (ok(r, `Transition added → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
    }, "Add transition", cancel));
  },

  async categories(body, m) {
    selfContainedList(body, t("management.currentCategories"), [
      { header: t("management.code"), cls: "mono", get: (c) => c.code },
      { header: t("management.name"), get: (c) => c.name },
    ], m.categories, t("management.noCategories"), t("management.addCategory"), (cancel) => manageCard(t("management.addCategory"), [
      ["code", h("input", { id: "ac_code", placeholder: "e.g. 105.04.09" })],
      ["name", h("input", { id: "ac_name", placeholder: "Name" })],
    ], async () => {
      const r = await api("POST", `/api/admin/categories`, { code: $("#ac_code").value, name: $("#ac_name").value });
      if (ok(r, "Category added")) { await refreshMeta(); reManage(); }
    }, "Add category", cancel));
  },

  async forms(body, m) {
    const audienceLabel = (audience) => audience === "both" ? t("management.audienceBoth") : audience === "worker" ? t("management.audienceWorker") : t("management.audienceCustomer");
    selfContainedList(body, t("management.caseForms"), [
      { header: t("management.formId"), cls: "mono", get: (f) => f.formId },
      { header: t("management.audience"), get: (f) => audienceLabel(f.audience) },
      { header: t("management.titleColumn"), get: (f) => f.title },
      { header: t("management.approval"), get: (f) => f.requiresApproval ? t("management.required") : "—" },
    ], m.caseForms || [], t("management.noCaseForms"), t("management.createCaseForm"), (cancel) => formCreateCard(m, "case", cancel), (form, cancel) => formCreateCard(m, "case", cancel, form));
    selfContainedList(body, t("management.operationForms"), [
      { header: t("management.formId"), cls: "mono", get: (f) => f.formId },
      { header: t("management.audience"), get: (f) => audienceLabel(f.audience) },
      { header: t("management.titleColumn"), get: (f) => f.title },
      { header: t("management.operationType"), get: (f) => f.operationType || "—" },
      { header: t("management.attachments"), get: (f) => f.allowAttachments ? t("common.yes") : "—" },
    ], m.operationForms || [], t("management.noOperationForms"), t("management.createOperationForm"), (cancel) => formCreateCard(m, "operation", cancel), (form, cancel) => formCreateCard(m, "operation", cancel, form));
  },

  async rules(body) {
    body.append(gapNote());
    body.append(ruleCreateCard());
  },

  async authorizations(body) {
    body.append(gapNote());
    body.append(h("div", { class: "row" }, manageCard("Grant worker authorization", [
      ["worker", h("select", { id: "ga_worker" }, ...["w-anna", "w-bo", "w-cara", "w-admin"].map((w) => h("option", null, w)))],
      ["category", h("input", { id: "ga_cat", placeholder: "e.g. 300" })],
      ["can approve", h("select", { id: "ga_appr" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "yes"))],
    ], async () => {
      const r = await api("POST", `/api/admin/authorizations`, { workerId: $("#ga_worker").value, registryId: state.registry, categoryId: $("#ga_cat").value, canApprove: $("#ga_appr").value === "true" });
      if (ok(r, "Authorization granted")) reManage();
    }, "Grant")));
  },

  async tokens(body) {
    body.append(gapNote());
    const tokCard = h("div", { class: "card" }, h("h3", null, "Mint API token (method × category scope)"),
      h("div", { class: "inline" },
        h("label", { class: "inline" }, "Methods ", ...["GET", "POST", "PUT", "DELETE"].map((mm) => h("label", { class: "inline" }, h("input", { type: "checkbox", id: "tk_m_" + mm, checked: mm === "GET" }), mm)))),
      h("div", { class: "field" }, h("label", null, "Resources (comma)"), h("input", { id: "tk_res", value: "cases" })),
      h("div", { class: "field" }, h("label", null, "Category scope"), h("input", { id: "tk_cat", value: "105" })),
      h("div", { class: "field" }, h("label", null, "Published only"), h("select", { id: "tk_pub" }, h("option", { value: "true" }, "true"), h("option", { value: "false" }, "false"))),
      h("button", { class: "btn", onclick: async () => {
        const methods = ["GET", "POST", "PUT", "DELETE"].filter((mm) => $("#tk_m_" + mm).checked);
        const r = await api("POST", `/api/admin/registries/${state.registry}/tokens`, { methods, resources: $("#tk_res").value.split(",").map((s) => s.trim()).filter(Boolean), categoryScope: $("#tk_cat").value || undefined, publishedOnly: $("#tk_pub").value === "true" });
        if (ok(r, "Token minted")) { $("#tk_out").innerHTML = ""; $("#tk_out").append(h("div", { class: "token-raw" }, `${r.data.tokenId}\n${r.data.raw}`)); }
      } }, "Mint token"),
      h("div", { id: "tk_out", style: "margin-top:10px" }));
    body.append(tokCard);
    body.append(h("div", { class: "row" }, manageCard("Revoke token by ID", [
      ["token ID", h("input", { id: "tk_rev", placeholder: "the tokenId shown when minted" })],
    ], async () => {
      const id = $("#tk_rev").value.trim(); if (!id) { toast("Token ID required", "err"); return; }
      const r = await api("POST", `/api/admin/registries/${state.registry}/tokens/${encodeURIComponent(id)}/revoke`, {});
      ok(r, "Token revoked");
    }, "Revoke")));
  },

  async config(body, m) {
    const cv = await api("GET", `/api/admin/registries/${state.registry}/config-versions`);
    const versions = cv.status === 200 ? cv.data.versions : [];
    if (cv.status !== 200) { body.append(h("div", { class: "card" }, h("h3", null, `Config versions — ${m.name}`), h("div", { class: "hint" }, "Admin only. Switch to Admin to view config versions."))); return; }
    body.append(listCard(`Config versions — ${m.name}`, [
      { header: "Version", get: (ver) => "v" + ver.version },
      { header: "Applied", cls: "mono", get: (ver) => ver.appliedAt },
      { header: "Summary", get: (ver) => ver.summary },
    ], versions, "No config versions recorded yet."));
  },

  async exports(body) {
    body.append(h("div", { class: "row" }, manageCard("Run scheduled export", [], async () => {
      const r = await api("POST", `/api/admin/exports/run`, {});
      if (ok(r, "Export run complete")) {
        const lines = (r.data.results || []).map((x) => `${x.registryId}: ${x.status}, ${x.caseCount} case(s)`).join("\n");
        toast(lines || "no registries", "ok");
      }
    }, "Run export now")));
  },
};

// ---- Management create forms (Forms + Rules) -------------------------------

function schemaPropertyRow(name = "", spec = {}, required = false) {
  const row = h("div", { class: "schema-property" },
    h("div", { class: "schema-primary" },
      h("div", { class: "field" }, h("label", null, t("management.propertyName")), h("input", { "data-schema-name": true, value: name, placeholder: "reason" })),
      h("div", { class: "field" }, h("label", null, t("management.type")), h("select", { "data-schema-type": true },
        ...["string", "number", "integer", "boolean"].map((type) => h("option", { value: type, selected: (spec.type || "string") === type }, type)))),
      h("label", { class: "inline schema-check" }, h("input", { type: "checkbox", "data-schema-required": true, checked: required }), t("management.propertyRequired"))),
    h("div", { class: "schema-validation" },
      h("div", { class: "field schema-number" }, h("label", null, t("management.minimum")), h("input", { type: "number", step: "any", "data-schema-minimum": true, value: spec.minimum ?? "" })),
      h("div", { class: "field schema-number" }, h("label", null, t("management.maximum")), h("input", { type: "number", step: "any", "data-schema-maximum": true, value: spec.maximum ?? "" })),
      h("div", { class: "field schema-string" }, h("label", null, t("management.pattern")), h("input", { "data-schema-pattern": true, value: spec.pattern || "", placeholder: "^[A-Z]+$" })),
      h("div", { class: "field schema-message" }, h("label", null, t("management.validationMessage")), h("input", { "data-schema-message": true, value: spec.errorMessage || "" }))),
    h("div", { class: "schema-actions" },
      h("button", { class: "btn sm ghost", type: "button", onclick: () => row.remove() }, t("management.removeProperty"))));
  const updateConstraints = () => {
    const type = row.querySelector("[data-schema-type]").value;
    const supportsNumberValidation = type === "number" || type === "integer";
    const supportsStringValidation = type === "string";
    row.querySelectorAll(".schema-number").forEach((el) => (el.hidden = !supportsNumberValidation));
    row.querySelector(".schema-string").hidden = !supportsStringValidation;
    row.querySelector(".schema-message").hidden = !supportsNumberValidation && !supportsStringValidation;
  };
  row.querySelector("[data-schema-type]").addEventListener("change", updateConstraints);
  updateConstraints();
  return row;
}

function schemaBuilder(schema) {
  const properties = Object.entries(schema?.properties || {});
  const required = new Set(schema?.required || []);
  const rows = h("div", { class: "schema-properties" }, ...properties.map(([name, spec]) => schemaPropertyRow(name, spec, required.has(name))));
  return h("div", { class: "field schema-builder" },
    h("label", null, t("management.properties")), rows,
    h("button", { class: "btn sm ghost", type: "button", onclick: () => rows.append(schemaPropertyRow()) }, t("management.addProperty")));
}

function formCreateCard(m, kind, onCancel, existing = null) {
  const fieldChecks = m.fields.map((f) => h("label", { class: "inline" }, h("input", { type: "checkbox", "data-fs": f.name }), f.name));
  for (const input of fieldChecks) input.querySelector("input").checked = existing?.fieldSubset?.includes(input.querySelector("input").dataset.fs) || false;
  const audience = existing?.audience || "customer";
  return h("div", { class: "card" },
    h("h3", null, existing ? t("management.editForm") : kind === "case" ? t("management.createCaseForm") : t("management.createOperationForm")),
    h("div", { class: "field" }, h("label", null, t("management.formId")), h("input", { id: "fm_id", value: existing?.formId || "", disabled: !!existing, placeholder: t("management.formIdPlaceholder") })),
    h("div", { class: "field" }, h("label", null, t("management.titleColumn")), h("input", { id: "fm_title", value: existing?.title || "", placeholder: t("management.formTitlePlaceholder") })),
    h("div", { class: "field" }, h("label", null, t("management.formDescription")), h("textarea", { id: "fm_description", rows: "3", placeholder: t("management.formDescriptionPlaceholder") }, existing?.description || "")),
    h("div", { class: "field" }, h("label", null, t("management.audience")), h("select", { id: "fm_aud" }, h("option", { value: "customer", selected: audience === "customer" }, t("management.audienceCustomer")), h("option", { value: "worker", selected: audience === "worker" }, t("management.audienceWorker")), h("option", { value: "both", selected: audience === "both" }, t("management.audienceBoth")))),
    ...(kind === "case" ? [
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "fm_appr", checked: existing?.requiresApproval === true }), t("management.requiresApproval")),
      h("div", { class: "field" }, h("label", null, t("management.fieldSubset")), h("div", { class: "inline wrap" }, ...(fieldChecks.length ? fieldChecks : [h("span", { class: "op-meta" }, t("management.noFieldsDefined"))]))),
    ] : [
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "fm_att", checked: existing?.allowAttachments === true }), t("management.allowAttachments")),
      h("div", { class: "field" }, h("label", null, t("management.operationType")), h("input", { id: "fm_optype", value: existing?.operationType || "", placeholder: t("management.operationTypePlaceholder") })),
      schemaBuilder(existing?.propertySchema),
    ]),
    h("div", { class: "inline" },
      h("button", { class: "btn", onclick: (event) => submitForm(kind, event.currentTarget.closest(".card"), !!existing) }, existing ? t("common.save") : t("management.createForm")),
      h("button", { class: "btn ghost", onclick: onCancel }, t("common.cancel"))));
}

async function submitForm(kind, editor, editing = false) {
  const field = (selector) => editor.querySelector(selector);
  const formId = field("#fm_id").value.trim();
  const title = field("#fm_title").value.trim();
  const description = field("#fm_description").value.trim();
  if (!formId || !title || !description) { toast(t("management.formRequired"), "err"); return; }
  const body = { formId, title, description, audience: field("#fm_aud").value };
  if (kind === "case") body.requiresApproval = field("#fm_appr").checked;
  else body.allowAttachments = field("#fm_att").checked;
  const optype = kind === "operation" ? field("#fm_optype").value.trim() : "";
  if (optype) body.operationType = optype;
  const subset = [...editor.querySelectorAll("[data-fs]")].filter((el) => el.checked).map((el) => el.getAttribute("data-fs"));
  if (kind === "case" && subset.length) body.fieldSubset = subset;
  if (kind === "operation") {
    const properties = {}; const required = [];
    for (const row of editor.querySelectorAll(".schema-property")) {
      const name = row.querySelector("[data-schema-name]").value.trim();
      if (!name) { toast(t("management.propertyNameRequired"), "err"); return; }
      if (properties[name]) { toast(t("management.duplicateProperty", { name }), "err"); return; }
      const spec = { type: row.querySelector("[data-schema-type]").value };
      const supportsNumberValidation = spec.type === "number" || spec.type === "integer";
      const supportsStringValidation = spec.type === "string";
      const minimum = supportsNumberValidation ? row.querySelector("[data-schema-minimum]").value : "";
      const maximum = supportsNumberValidation ? row.querySelector("[data-schema-maximum]").value : "";
      const pattern = supportsStringValidation ? row.querySelector("[data-schema-pattern]").value : "";
      const errorMessage = row.querySelector("[data-schema-message]").value.trim();
      if (minimum !== "") spec.minimum = Number(minimum);
      if (maximum !== "") spec.maximum = Number(maximum);
      if (spec.minimum !== undefined && spec.maximum !== undefined && spec.minimum > spec.maximum) { toast(t("management.invalidRange", { name }), "err"); return; }
      if (pattern) { try { new RegExp(pattern); } catch { toast(t("management.invalidPattern", { name }), "err"); return; } spec.pattern = pattern; }
      if ((supportsNumberValidation || supportsStringValidation) && errorMessage) spec.errorMessage = errorMessage;
      properties[name] = spec;
      if (row.querySelector("[data-schema-required]").checked) required.push(name);
    }
    body.propertySchema = { type: "object", properties, required, additionalProperties: false };
  }
  const r = await api("POST", `/api/admin/registries/${state.registry}/${kind}-forms`, body);
  if (ok(r, `${editing ? "Form saved" : "Form created"} → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
}

function ruleCreateCard() {
  const actions = ["set_state", "update_values", "create_operation", "notify_customer", "send_to_integration", "export"];
  return h("div", { class: "card" },
    h("h3", null, "Create rule"),
    h("div", { class: "field" }, h("label", null, "Rule ID"), h("input", { id: "rl_id", placeholder: "e.g. auto_publish_on_decided" })),
    h("div", { class: "row" },
      h("div", { class: "col field" }, h("label", null, "On transition to state"), h("select", { id: "rl_to" }, h("option", { value: "" }, "(any state)"), ...meta().states.map((s) => h("option", { value: s.id }, s.name)))),
      h("div", { class: "col field" }, h("label", null, "Action type"), h("select", { id: "rl_action" }, ...actions.map((a) => h("option", null, a))))),
    h("div", { class: "field" }, h("label", null, "Action params JSON"), h("textarea", { id: "rl_params", rows: "3", placeholder: '{ "toState": "published" }' })),
    h("div", { class: "field" }, h("label", null, "Condition JSON — optional"), h("textarea", { id: "rl_cond", rows: "3", placeholder: '{ "field": "fee_paid", "equals": true }' })),
    h("div", { class: "field" }, h("label", null, "Ordering"), h("input", { id: "rl_order", type: "number", value: "0" })),
    h("button", { class: "btn", onclick: submitRule }, "Create rule"));
}

async function submitRule() {
  const ruleId = $("#rl_id").value.trim();
  if (!ruleId) { toast("Rule ID is required", "err"); return; }
  const body = { ruleId, actionType: $("#rl_action").value, ordering: Number($("#rl_order").value || 0) };
  const to = $("#rl_to").value; if (to) body.onToState = to;
  const paramsRaw = $("#rl_params").value.trim();
  if (paramsRaw) { let p; try { p = JSON.parse(paramsRaw); } catch { toast("Action params is not valid JSON", "err"); return; } body.actionParams = p; }
  const condRaw = $("#rl_cond").value.trim();
  if (condRaw) { let c; try { c = JSON.parse(condRaw); } catch { toast("Condition is not valid JSON", "err"); return; } body.condition = c; }
  const r = await api("POST", `/api/admin/registries/${state.registry}/rules`, body);
  if (ok(r, `Rule created → config v${r.data.version}`)) reManage();
}

// ---- Management shared building blocks -------------------------------------

function manageCard(title, rows, onSubmit, btnLabel, onCancel) {
  return h("div", { class: "col card" },
    h("h3", null, title),
    ...rows.map(([label, input]) => h("div", { class: "field" }, h("label", null, label), input)),
    h("div", { class: "inline" },
      h("button", { class: "btn", onclick: onSubmit }, btnLabel),
      onCancel && h("button", { class: "btn ghost", onclick: onCancel }, t("common.cancel"))));
}

/** Render a list and its create operation as one component. The editor replaces the list until saved or cancelled. */
function selfContainedList(body, title, cols, rows, emptyMsg, actionLabel, createForm, editForm) {
  const renderCard = () => {
    const showList = () => card.replaceWith(renderCard());
    const displayCols = editForm ? [...cols, { header: "", get: (row) => h("button", { class: "btn sm ghost", onclick: () => { card.replaceChildren(editForm(row, showList)); card.classList.add("editing"); } }, t("common.edit")) }] : cols;
    const card = listCard(title, displayCols, rows, emptyMsg);
    card.append(h("div", { class: "list-actions" },
      h("button", { class: "btn", onclick: () => {
        card.replaceChildren(createForm(showList));
        card.classList.add("editing");
      } }, actionLabel)));
    return card;
  };
  body.append(renderCard());
}

/** A card with a table of current items. `cols` = [{header, get, cls?}]. */
function listCard(title, cols, rows, emptyMsg) {
  const card = h("div", { class: "card" }, h("h3", null, `${title} (${rows.length})`));
  if (!rows.length) { card.append(h("div", { class: "empty" }, emptyMsg || "Nothing yet.")); return card; }
  const head = h("tr", null, ...cols.map((c) => h("th", null, c.header)));
  const tb = h("tbody");
  for (const row of rows) tb.append(h("tr", null, ...cols.map((c) => h("td", c.cls ? { class: c.cls } : null, c.get(row)))));
  card.append(h("table", null, h("thead", null, head), tb));
  return card;
}

function gapNote() {
  return h("div", { class: "hint" }, "No read endpoint yet — existing items aren’t listed. This section is create-only for now.");
}

// ---- shared building blocks ------------------------------------------------

function caseTable(m, cases, onOpen, extra) {
  const head = h("tr", null, h("th", null, t("table.diary")), h("th", null, t("table.category")), h("th", null, t("table.state")), h("th", null, ""));
  if (extra) head.append(h("th", null, extra.header));
  const tb = h("tbody");
  for (const c of cases) {
    const tr = h("tr", { class: "click", onclick: () => onOpen(c) },
      h("td", { class: "mono" }, c.diaryNumber),
      h("td", { class: "mono" }, c.category),
      h("td", null, stateBadge(m, c.state, c.isPublished)),
      h("td", null, h("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); onOpen(c); } }, t("common.open"))));
    if (extra) tr.append(h("td", null, extra.cell(c)));
    tb.append(tr);
  }
  return h("table", null, h("thead", null, head), tb);
}

async function caseDetailCard(tab, diary) {
  const m = meta();
  const r = await api("GET", `/api/registries/${state.registry}/cases/${encodeURIComponent(diary)}`);
  const card = h("div", { class: "card" });
  card.append(h("div", { class: "inline", style: "justify-content:space-between" },
    h("h3", null, t("case.heading", { diary })),
    h("button", { class: "btn ghost sm", onclick: () => { state.open[tab] = null; render(); } }, t("common.close"))));
  if (r.status !== 200) { card.append(h("div", { class: "hint" }, t("case.notVisible", { status: r.status }))); return card; }
  const c = r.data.case;
  card.append(h("dl", { class: "kv" },
    h("dt", null, t("table.state")), h("dd", null, stateBadge(m, c.state, tab === "publishing" || c.isPublished)),
    h("dt", null, t("table.category")), h("dd", { class: "mono" }, c.category),
    h("dt", null, c.created ? t("case.created") : t("case.published")), h("dd", { class: "mono" }, c.created || c.publishedAt || "—")));
  if (c.fields && Object.keys(c.fields).length) {
    const publicFields = h("dl", { class: "kv" });
    for (const [name, value] of Object.entries(c.fields)) publicFields.append(h("dt", null, name), h("dd", null, String(value ?? "—")));
    card.append(h("h3", null, t("case.publishedFields")), publicFields);
  }

  // Worker actions.
  if (tab === "worker" && state.identity.startsWith("worker:")) card.append(await workerActions(m, c, r.data.history));
  // Operations are a self-contained list. Workers can select operation forms;
  // customers can select any form available for acting on their own case.
  const isCustomer = tab === "customer" && state.identity.startsWith("customer:");
  const splitForms = [
    ...(m.caseForms || []).map((form) => ({ ...form, kind: "case" })),
    ...(m.operationForms || []).map((form) => ({ ...form, kind: "operation" })),
  ];
  const configuredForms = m.caseForms || m.operationForms ? splitForms : (m.forms || []);
  const forms = tab === "worker" && state.identity.startsWith("worker:")
    ? configuredForms.filter((form) => (form.audience === "worker" || form.audience === "both") && form.kind === "operation")
    : isCustomer ? configuredForms.filter((form) => form.audience === "customer" || form.audience === "both") : [];
  card.append(operationList(c, r.data.history, forms, isCustomer));
  return card;
}

async function workerActions(m, c, history) {
  const wrap = h("div", null);
  // Transition control.
  const allowed = (m.transitions || []).filter((t) => t.from === c.state).map((t) => t.to);
  const tRow = h("div", { class: "inline action-picker", style: "margin:8px 0" });
  if (allowed.length) {
    const sel = h("select", { id: "tr_to", "aria-label": t("transition.stateLabel") },
      h("option", { value: "", disabled: true, selected: true }, t("transition.chooseState")),
      ...allowed.map((s) => h("option", { value: s }, (m.states.find((x) => x.id === s) || {}).name || s)));
    tRow.append(h("button", { class: "btn", onclick: async () => {
      if (!sel.value) { toast(t("transition.chooseStateRequired"), "err"); sel.focus(); return; }
      const r = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/transition`, { toState: sel.value });
      if (ok(r, `Now ${sel.value}${r.data.rulesFired ? ` · ${r.data.rulesFired} rule(s) fired` : ""}`)) { state.open.worker = c.diaryNumber; renderWorker($("#view")); }
    } }, t("transition.apply")), sel);
  } else tRow.append(h("span", { class: "op-meta" }, "No onward transitions from this state."));
  wrap.append(tRow);

  // Assign + explicit publication projection.
  const actions = h("div", { class: "inline", style: "margin:8px 0" },
    h("button", { class: "btn sm ghost", onclick: async () => { const r = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/assign`, {}); ok(r, t("worker.assignedToast")); } }, t("worker.assign")),
    h("button", { class: "btn sm ghost", onclick: async () => {
      const fields = [...document.querySelectorAll("[data-publish-field]:checked")].map((el) => el.dataset.publishField);
      const operations = [...document.querySelectorAll("[data-publish-operation]:checked")].map((el) => Number(el.dataset.publishOperation));
      const r = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/publish`, { publish: !c.isPublished, fields, operations });
      if (ok(r, r.data && r.data.isPublished ? "Published" : "Unpublished")) { state.open.worker = c.diaryNumber; renderWorker($("#view")); }
    } }, c.isPublished ? "Unpublish" : "Publish"));
  wrap.append(actions);
  if (!c.isPublished) {
    const eligible = m.fields.filter((field) => field.publicationEligible);
    wrap.append(h("div", { class: "hint" }, "Select exactly what the public projection may contain:"));
    wrap.append(h("div", { class: "inline wrap" }, ...eligible.map((field) =>
      h("label", { class: "inline" }, h("input", { type: "checkbox", "data-publish-field": field.name }), field.name))));
    wrap.append(h("div", { class: "inline wrap" }, ...history.map((op) =>
      h("label", { class: "inline" }, h("input", { type: "checkbox", "data-publish-operation": String(op.operationId) }), `#${op.operationId} ${op.type}`))));
  }

  return wrap;
}

function operationList(c, history, forms, allCustomerForms = false) {
  const card = h("div", { class: "card operation-list" }, h("h3", null, `${t("case.operations")} (${history.length})`));
  const hist = h("div", { class: "hist", "aria-label": t("case.history") });
  for (const op of history) {
    const item = h("div", { class: "op" },
      h("span", { class: "op-type" }, `#${op.operationId} ${op.type}`), " ",
      h("span", { class: "op-meta" }, `${op.direction} · by ${op.actorKind}${op.comment ? " · " + op.comment : ""}`));
    if (op.properties && Object.keys(op.properties).length) {
      const values = h("dl", { class: "operation-properties" });
      for (const [name, value] of Object.entries(op.properties)) values.append(h("dt", null, name), h("dd", null, value === null ? "—" : String(value)));
      item.append(values);
    }
    hist.append(item);
  }
  card.append(hist);

  if (forms.length) {
    const select = h("select", { "aria-label": t(allCustomerForms ? "form.formLabel" : "operation.formLabel") },
      h("option", { value: "", disabled: true, selected: true }, t(allCustomerForms ? "form.choose" : "operation.chooseForm")),
      ...forms.map((f) => h("option", { value: f.formId }, f.title)));
    card.append(h("div", { class: "list-actions inline action-picker" },
      h("button", { class: "btn", onclick: () => {
        const form = forms.find((f) => f.formId === select.value);
        if (!form) { toast(t(allCustomerForms ? "form.chooseRequired" : "operation.chooseFormRequired"), "err"); select.focus(); return; }
        const showList = () => card.replaceWith(operationList(c, history, forms, allCustomerForms));
        const editor = form.kind === "case" ? caseFormBlock(form, c, showList) : operationFormBlock(form, c, showList);
        card.replaceChildren(editor);
        card.classList.add("editing");
      } }, t(allCustomerForms ? "form.open" : "operation.add")), select));
  }
  return card;
}

function caseFormBlock(f, c, onCancel) {
  const m = meta();
  const subset = f.fieldSubset || m.fields.map((x) => x.name);
  const defs = m.fields.filter((x) => subset.includes(x.name));
  const box = h("div", { class: "card", style: "background:var(--panel-2)" }, h("h3", null, f.title + (f.requiresApproval ? " (needs approval)" : "")));
  if (f.description) box.append(h("p", { class: "hint" }, f.description));
  for (const d of defs) box.append(h("div", { class: "field" }, h("label", null, d.name), fieldInput(d)));
  const submit = h("button", { class: "btn sm", onclick: async () => {
    const fields = {};
    for (const d of defs) { const val = readField(d); if (val !== undefined) fields[d.name] = val; }
    const r = await api("POST", `/api/registries/${state.registry}/forms/${f.formId}/submit`, { diaryNumber: c.diaryNumber, fields });
    if (ok(r, r.status === 202 ? "Submitted — awaiting worker approval" : "Applied")) render();
  } }, t("common.submit"));
  box.append(h("div", { class: "inline" }, submit,
    onCancel && h("button", { class: "btn sm ghost", onclick: onCancel }, t("common.cancel"))));
  return box;
}

function operationFormBlock(f, c, onCancel) {
  const schema = f.propertySchema || { properties: {}, required: [] };
  const props = Object.entries(schema.properties || {});
  const box = h("div", { class: "card", style: "background:var(--panel-2)" }, h("h3", null, f.title));
  if (f.description) box.append(h("p", { class: "hint" }, f.description));
  for (const [name, spec] of props) {
    const req = (schema.required || []).includes(name);
    const attrs = { id: "op_" + name, required: req, min: spec.minimum, max: spec.maximum, pattern: spec.pattern, title: spec.errorMessage };
    const input = spec.type === "boolean" ? h("select", attrs, h("option", { value: "" }, "—"), h("option", { value: "false" }, "false"), h("option", { value: "true" }, "true"))
      : h("input", { ...attrs, type: spec.type === "integer" || spec.type === "number" ? "number" : "text", step: spec.type === "number" ? "any" : spec.type === "integer" ? "1" : null });
    box.append(h("div", { class: "field" }, h("label", null, name, req ? h("span", { class: "req" }, ` · ${t("form.required")}`) : h("span", { class: "optional" }, ` · ${t("form.optional")}`)), input));
  }
  if (f.allowAttachments) box.append(h("div", { class: "field" },
    h("label", null, "Attachment filename"), h("input", { id: "op_att_name", placeholder: "deed.txt" }),
    h("label", null, "Attachment text"), h("input", { id: "op_att_body", placeholder: "content" })));
  const submit = h("button", { class: "btn sm", onclick: async () => {
    const properties = {};
    for (const [name, spec] of props) {
      const el = $("#op_" + name); if (!el || el.value === "") continue;
      properties[name] = spec.type === "boolean" ? el.value === "true" : (spec.type === "integer" || spec.type === "number") ? Number(el.value) : el.value;
    }
    const missing = props.find(([name]) => (schema.required || []).includes(name) && !$("#op_" + name)?.value);
    if (missing) { toast(t("operation.requiredProperty", { name: missing[0] }), "err"); $("#op_" + missing[0]).focus(); return; }
    const invalid = props.find(([name]) => $("#op_" + name)?.value && !$("#op_" + name).checkValidity());
    if (invalid) { toast(invalid[1].errorMessage || t("operation.invalidProperty", { name: invalid[0] }), "err"); $("#op_" + invalid[0]).focus(); return; }
    const body = { diaryNumber: c.diaryNumber, properties };
    if (f.allowAttachments && $("#op_att_name") && $("#op_att_name").value) {
      body.attachments = [{ filename: $("#op_att_name").value, contentType: "text/plain", base64: btoa($("#op_att_body").value || "") }];
    }
    const r = await api("POST", `/api/registries/${state.registry}/forms/${f.formId}/submit`, body);
    if (ok(r, t("operation.recorded"))) render();
  } }, t("common.submit"));
  box.append(h("div", { class: "inline" }, submit,
    onCancel && h("button", { class: "btn sm ghost", onclick: onCancel }, t("common.cancel"))));
  return box;
}

function categorySelect() {
  return h("select", { id: "cat_sel" }, ...meta().categories.map((c) => h("option", { value: c.code }, `${c.code} — ${c.name}`)));
}
function stateSelect(id) {
  return h("select", { id }, ...meta().states.map((s) => h("option", { value: s.id }, s.name)));
}

boot().catch((e) => { console.error(e); toast(t("error.startFailed", { message: e.message }), "err"); });
