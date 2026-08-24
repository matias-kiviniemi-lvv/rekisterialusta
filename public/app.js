"use strict";
/*
 * Registry Platform — MVP console (vanilla JS, no build step).
 * Drives the REST API. "Acting as" chooses the stub-identity bearer so you can
 * watch the two auth systems and admin gating behave differently per role.
 */

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
  const res = await fetch(path, opts);
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
  toast(`${r.status}: ${r.data && r.data.error ? r.data.error : "request failed"}`, "err");
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
  if (isPublished) els.push(" ", h("span", { class: "badge pub" }, "published"));
  return els;
}

// ---- boot ------------------------------------------------------------------

async function boot() {
  const idSel = $("#identity");
  for (const [k, v] of Object.entries(IDENTITIES)) idSel.append(h("option", { value: k }, v.label));
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
  if (!meta()) { v.append(h("p", { class: "empty" }, "Loading…")); return; }
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
  v.append(h("h2", null, "Customer portal"), h("p", { class: "sub" }, "See and act on your own cases, and start new ones."));
  if (!state.identity.startsWith("customer:")) {
    v.append(h("div", { class: "hint" }, "Switch “Acting as” to Citizen One or Two to use this portal."));
  }

  const bar = h("div", { class: "inline", style: "margin-bottom:14px" },
    h("button", { class: "btn", onclick: () => showNewCaseForm(v) }, "+ Start a new case"),
    h("button", { class: "btn ghost sm", onclick: () => render() }, "Refresh"));
  v.append(bar);

  const listCard = h("div", { class: "card" }, h("h3", null, "My cases"));
  v.append(listCard);
  const r = await api("GET", `/api/registries/${state.registry}/my-cases`);
  if (r.status !== 200) { listCard.append(h("div", { class: "hint" }, "Sign in as a customer to see your cases.")); }
  else if (!r.data.cases.length) listCard.append(h("div", { class: "empty" }, "No cases yet. Start one above."));
  else listCard.append(caseTable(m, r.data.cases, (c) => { state.open.customer = c.diaryNumber; renderCustomer(v).catch(console.error); }));

  if (state.open.customer) v.append(await caseDetailCard("customer", state.open.customer));
}

function showNewCaseForm(v) {
  const m = meta();
  const initial = m.states[0];
  const form = h("div", { class: "card" },
    h("h3", null, "Start a new case"),
    h("div", { class: "field" }, h("label", null, "Category"), categorySelect()),
    ...m.fields.map((f) => h("div", { class: "field" },
      h("label", null, f.name, f.nullable ? "" : h("span", { class: "req" }, " *")), fieldInput(f))),
    h("p", { class: "sub" }, `Opens in initial state: ${initial.name}`),
    h("button", { class: "btn", onclick: async () => {
      const fields = {};
      for (const f of m.fields) { const val = readField(f); if (val !== undefined && val !== null) fields[f.name] = val; }
      const r = await api("POST", `/api/registries/${state.registry}/cases`, { category: $("#cat_sel").value, initialState: initial.id, fields });
      if (ok(r, `Created ${r.data.diaryNumber}`)) { state.open.customer = r.data.diaryNumber; renderCustomer($("#view")); }
    } }, "Create case"));
  v.append(form);
  form.scrollIntoView({ behavior: "smooth" });
}

// ---- Worker portal ---------------------------------------------------------

async function renderWorker(v) {
  const m = meta();
  v.innerHTML = "";
  v.append(h("h2", null, "Case-worker portal"), h("p", { class: "sub" }, "Your queue, bounded by category authorization."));
  if (!state.identity.startsWith("worker:")) v.append(h("div", { class: "hint" }, "Switch “Acting as” to a worker (Anna 105, Bo 200, Cara 300) to use this portal."));

  const views = [["assigned", "Assigned to me"], ["unassigned", "Unassigned (opted-in)"], ["authorized", "All authorized"]];
  const pills = h("div", { class: "pillbar" }, ...views.map(([k, label]) =>
    h("button", { class: state.workerView === k ? "active" : "", onclick: () => { state.workerView = k; renderWorker(v); } }, label)));
  v.append(pills);

  const listCard = h("div", { class: "card" });
  v.append(listCard);
  const r = await api("GET", `/api/registries/${state.registry}/worker/cases?view=${state.workerView}`);
  if (r.status !== 200) listCard.append(h("div", { class: "hint" }, "Worker authentication required."));
  else if (!r.data.cases.length) listCard.append(h("div", { class: "empty" }, "No cases in this view."));
  else {
    const extra = state.workerView === "unassigned"
      ? { header: "", cell: (c) => h("button", { class: "btn sm ghost", onclick: async (e) => { e.stopPropagation(); const a = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/assign`, {}); if (ok(a, "Assigned to you")) renderWorker(v); } }, "Assign to me") }
      : null;
    listCard.append(caseTable(m, r.data.cases, (c) => { state.open.worker = c.diaryNumber; renderWorker(v); }, extra));
  }

  // Pending approvals.
  const pend = await api("GET", `/api/registries/${state.registry}/worker/pending`);
  if (pend.status === 200 && pend.data.pending.length) {
    const card = h("div", { class: "card" }, h("h3", null, "Pending customer submissions to approve"));
    const t = h("table", null, h("thead", null, h("tr", null, h("th", null, "Case"), h("th", null, "Form"), h("th", null, "Proposed"), h("th", null, ""))));
    const tb = h("tbody");
    for (const p of pend.data.pending) {
      tb.append(h("tr", null,
        h("td", { class: "mono" }, p.diaryNumber),
        h("td", null, p.formId),
        h("td", { class: "mono" }, JSON.stringify(p.payload)),
        h("td", { class: "inline" },
          h("button", { class: "btn sm", onclick: async () => { const a = await api("POST", `/api/registries/${state.registry}/pending/${p.pendingId}/approve`, {}); if (ok(a, "Approved")) renderWorker(v); } }, "Approve"),
          h("button", { class: "btn sm danger", onclick: async () => { const a = await api("POST", `/api/registries/${state.registry}/pending/${p.pendingId}/reject`, {}); if (ok(a, "Rejected")) renderWorker(v); } }, "Reject"))));
    }
    t.append(tb); card.append(t); v.append(card);
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
  v.append(h("h2", null, "Publishing portal"), h("p", { class: "sub" }, "Literal substring search across published case fields and published operation content — nothing private is searched."));
  const queryInput = h("input", { id: "pub_query", placeholder: "at least 3 characters", style: "min-width:280px", value: keepQuery });
  const catInput = h("input", { id: "pub_cat", placeholder: "category prefix e.g. 105", style: "max-width:220px", value: keepCat });
  const scope = h("select", { id: "pub_scope" }, h("option", { value: "registry" }, "Current registry"), h("option", { value: "all" }, "All registries"));
  scope.value = keepScope;
  v.append(h("form", {
    class: "inline", style: "margin-bottom:14px",
    onsubmit: (event) => { event.preventDefault(); renderPublishing(v, true); },
  }, queryInput, catInput, scope, h("button", { class: "btn", type: "submit" }, "Search")));
  const card = h("div", { class: "card" }, h("h3", null, "Published cases"));
  v.append(card);
  const params = new URLSearchParams();
  if (keepQuery) params.set("q", keepQuery);
  if (keepCat) params.set("category", keepCat);
  const path = keepScope === "all" ? "/api/published/search" : `/api/registries/${state.registry}/published`;
  const r = await api("GET", `${path}?${params}`);
  if (!ok(r)) { card.append(h("div", { class: "empty" }, r.data.error)); return; }
  if (!r.data.cases.length) card.append(h("div", { class: "empty" }, "No published cases. (A worker can publish a case from its detail view.)"));
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
  v.append(h("h2", null, "Management portal"), h("p", { class: "sub" }, "Configure a registry without a release. Admin only."));
  if (state.identity !== "worker:w-admin") v.append(h("div", { class: "hint" }, "Switch “Acting as” to Admin to use the management portal."));

  // Sub-tab navigation — one section per managed resource type.
  const nav = h("div", { class: "pillbar subnav" }, ...MGMT_SECTIONS.map(([key, label]) =>
    h("button", { class: state.mgmtSection === key ? "active" : "", onclick: () => { state.mgmtSection = key; renderManagement(v); } }, label)));
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
    body.append(listCard("Current fields", [
      { header: "Name", cls: "mono", get: (f) => f.name },
      { header: "Type", get: (f) => f.type },
      { header: "Nullable", get: (f) => (f.nullable ? "yes" : "no") },
    ], m.fields, "No fields defined yet."));
    body.append(h("div", { class: "row" }, manageCard("Add statutory field", [
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
    }, "Add field (schema migration)")));
  },

  async states(body, m) {
    body.append(listCard("Current states", [
      { header: "ID", cls: "mono", get: (s) => s.id },
      { header: "Name", get: (s) => s.name },
      { header: "Open", get: (s) => (s.isOpen ? "open" : "closed") },
      { header: "Waiting", get: (s) => (s.isWaitingForCustomer ? "waiting for customer" : "—") },
    ], m.states, "No states defined yet."));
    body.append(h("div", { class: "row" }, manageCard("Add state", [
      ["id", h("input", { id: "as_id", placeholder: "e.g. appealed" })],
      ["name", h("input", { id: "as_name", placeholder: "Appealed" })],
      ["open", h("select", { id: "as_open" }, h("option", { value: "true" }, "open"), h("option", { value: "false" }, "closed"))],
      ["waiting", h("select", { id: "as_wait" }, h("option", { value: "false" }, "no"), h("option", { value: "true" }, "waiting for customer"))],
    ], async () => {
      const r = await api("POST", `/api/admin/registries/${state.registry}/states`, { id: $("#as_id").value, name: $("#as_name").value, isOpen: $("#as_open").value === "true", isWaitingForCustomer: $("#as_wait").value === "true" });
      if (ok(r, `State added → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
    }, "Add state")));
  },

  async transitions(body, m) {
    const nameOf = (id) => (m.states.find((x) => x.id === id) || {}).name || id;
    body.append(listCard("Current transitions", [
      { header: "From", get: (t) => nameOf(t.from) },
      { header: "", get: () => "→" },
      { header: "To", get: (t) => nameOf(t.to) },
    ], m.transitions, "No transitions defined yet."));
    body.append(h("div", { class: "row" }, manageCard("Add transition", [
      ["from", stateSelect("at_from")],
      ["to", stateSelect("at_to")],
    ], async () => {
      const r = await api("POST", `/api/admin/registries/${state.registry}/transitions`, { from: $("#at_from").value, to: $("#at_to").value });
      if (ok(r, `Transition added → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
    }, "Add transition")));
  },

  async categories(body, m) {
    body.append(listCard("Current categories (platform-wide)", [
      { header: "Code", cls: "mono", get: (c) => c.code },
      { header: "Name", get: (c) => c.name },
    ], m.categories, "No categories defined yet."));
    body.append(h("div", { class: "row" }, manageCard("Add category", [
      ["code", h("input", { id: "ac_code", placeholder: "e.g. 105.04.09" })],
      ["name", h("input", { id: "ac_name", placeholder: "Name" })],
    ], async () => {
      const r = await api("POST", `/api/admin/categories`, { code: $("#ac_code").value, name: $("#ac_name").value });
      if (ok(r, "Category added")) { await refreshMeta(); reManage(); }
    }, "Add category")));
  },

  async forms(body, m) {
    body.append(listCard("Current forms", [
      { header: "Form ID", cls: "mono", get: (f) => f.formId },
      { header: "Kind", get: (f) => f.kind },
      { header: "Audience", get: (f) => f.audience },
      { header: "Title", get: (f) => f.title },
      { header: "Approval", get: (f) => (f.requiresApproval ? "required" : "—") },
      { header: "Attach", get: (f) => (f.allowAttachments ? "yes" : "—") },
    ], m.forms, "No forms defined yet."));
    body.append(formCreateCard(m));
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

function formCreateCard(m) {
  const fieldChecks = m.fields.map((f) => h("label", { class: "inline" }, h("input", { type: "checkbox", "data-fs": f.name }), f.name));
  return h("div", { class: "card" },
    h("h3", null, "Create form"),
    h("div", { class: "field" }, h("label", null, "Form ID"), h("input", { id: "fm_id", placeholder: "e.g. permit_supplement" })),
    h("div", { class: "field" }, h("label", null, "Title"), h("input", { id: "fm_title", placeholder: "Supplement request" })),
    h("div", { class: "row" },
      h("div", { class: "col field" }, h("label", null, "Kind"), h("select", { id: "fm_kind" }, h("option", { value: "case" }, "case"), h("option", { value: "operation" }, "operation"))),
      h("div", { class: "col field" }, h("label", null, "Audience"), h("select", { id: "fm_aud" }, h("option", { value: "customer" }, "customer"), h("option", { value: "worker" }, "worker")))),
    h("div", { class: "inline", style: "margin:8px 0" },
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "fm_appr" }), "requires approval"),
      h("label", { class: "inline" }, h("input", { type: "checkbox", id: "fm_att" }), "allow attachments")),
    h("div", { class: "field" }, h("label", null, "Operation type — operation kind only, optional"), h("input", { id: "fm_optype", placeholder: "e.g. supplement" })),
    h("div", { class: "field" }, h("label", null, "Field subset — case kind; leave all unchecked to allow all fields"), h("div", { class: "inline wrap" }, ...(fieldChecks.length ? fieldChecks : [h("span", { class: "op-meta" }, "no fields defined")]))),
    h("div", { class: "field" }, h("label", null, "Property schema JSON — operation kind, optional"), h("textarea", { id: "fm_schema", rows: "5", placeholder: '{ "properties": { "reason": { "type": "string" } }, "required": ["reason"] }' })),
    h("button", { class: "btn", onclick: submitForm }, "Create form"));
}

async function submitForm() {
  const kind = $("#fm_kind").value;
  const formId = $("#fm_id").value.trim();
  const title = $("#fm_title").value.trim();
  if (!formId || !title) { toast("Form ID and Title are required", "err"); return; }
  const body = { formId, title, kind, audience: $("#fm_aud").value, requiresApproval: $("#fm_appr").checked, allowAttachments: $("#fm_att").checked };
  const optype = $("#fm_optype").value.trim();
  if (optype) body.operationType = optype;
  const subset = [...document.querySelectorAll("[data-fs]")].filter((el) => el.checked).map((el) => el.getAttribute("data-fs"));
  if (kind === "case" && subset.length) body.fieldSubset = subset;
  const schemaRaw = $("#fm_schema").value.trim();
  if (schemaRaw) {
    let parsed; try { parsed = JSON.parse(schemaRaw); } catch { toast("Property schema is not valid JSON", "err"); return; }
    body.propertySchema = parsed;
  }
  const r = await api("POST", `/api/admin/registries/${state.registry}/forms`, body);
  if (ok(r, `Form created → config v${r.data.version}`)) { await refreshMeta(); reManage(); }
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

function manageCard(title, rows, onSubmit, btnLabel) {
  return h("div", { class: "col card" },
    h("h3", null, title),
    ...rows.map(([label, input]) => h("div", { class: "field" }, h("label", null, label), input)),
    h("button", { class: "btn", onclick: onSubmit }, btnLabel));
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
  const head = h("tr", null, h("th", null, "Diary number"), h("th", null, "Category"), h("th", null, "State"), h("th", null, ""));
  if (extra) head.append(h("th", null, extra.header));
  const tb = h("tbody");
  for (const c of cases) {
    const tr = h("tr", { class: "click", onclick: () => onOpen(c) },
      h("td", { class: "mono" }, c.diaryNumber),
      h("td", { class: "mono" }, c.category),
      h("td", null, stateBadge(m, c.state, c.isPublished)),
      h("td", null, h("button", { class: "btn sm ghost", onclick: (e) => { e.stopPropagation(); onOpen(c); } }, "Open")));
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
    h("h3", null, "Case " + diary),
    h("button", { class: "btn ghost sm", onclick: () => { state.open[tab] = null; render(); } }, "Close")));
  if (r.status !== 200) { card.append(h("div", { class: "hint" }, `Not visible to this identity (${r.status}). Try a different “Acting as”.`)); return card; }
  const c = r.data.case;
  card.append(h("dl", { class: "kv" },
    h("dt", null, "State"), h("dd", null, stateBadge(m, c.state, tab === "publishing" || c.isPublished)),
    h("dt", null, "Category"), h("dd", { class: "mono" }, c.category),
    h("dt", null, c.created ? "Created" : "Published"), h("dd", { class: "mono" }, c.created || c.publishedAt || "—")));
  if (c.fields && Object.keys(c.fields).length) {
    const publicFields = h("dl", { class: "kv" });
    for (const [name, value] of Object.entries(c.fields)) publicFields.append(h("dt", null, name), h("dd", null, String(value ?? "—")));
    card.append(h("h3", null, "Published fields"), publicFields);
  }

  // Worker actions.
  if (tab === "worker" && state.identity.startsWith("worker:")) card.append(await workerActions(m, c, r.data.history));
  // Customer forms.
  if (tab === "customer" && state.identity.startsWith("customer:")) card.append(customerForms(m, c));

  // History.
  card.append(h("h3", null, "History (append-only)"));
  const hist = h("div", { class: "hist" });
  for (const op of r.data.history) hist.append(h("div", { class: "op" },
    h("span", { class: "op-type" }, `#${op.operationId} ${op.type}`), " ",
    h("span", { class: "op-meta" }, `${op.direction} · by ${op.actorKind}${op.comment ? " · " + op.comment : ""}`)));
  card.append(hist);
  return card;
}

async function workerActions(m, c, history) {
  const wrap = h("div", null);
  // Transition control.
  const allowed = (m.transitions || []).filter((t) => t.from === c.state).map((t) => t.to);
  const tRow = h("div", { class: "inline", style: "margin:8px 0" });
  if (allowed.length) {
    const sel = h("select", { id: "tr_to" }, ...allowed.map((s) => h("option", { value: s }, (m.states.find((x) => x.id === s) || {}).name || s)));
    tRow.append("Move to ", sel, h("button", { class: "btn sm", onclick: async () => {
      const r = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/transition`, { toState: sel.value });
      if (ok(r, `Now ${sel.value}${r.data.rulesFired ? ` · ${r.data.rulesFired} rule(s) fired` : ""}`)) { state.open.worker = c.diaryNumber; renderWorker($("#view")); }
    } }, "Apply transition"));
  } else tRow.append(h("span", { class: "op-meta" }, "No onward transitions from this state."));
  wrap.append(tRow);

  // Assign + explicit publication projection.
  const actions = h("div", { class: "inline", style: "margin:8px 0" },
    h("button", { class: "btn sm ghost", onclick: async () => { const r = await api("POST", `/api/registries/${state.registry}/cases/${encodeURIComponent(c.diaryNumber)}/assign`, {}); ok(r, "Assigned to you"); } }, "Assign to me"),
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

  // Worker operation forms.
  const opForms = (m.forms || []).filter((f) => f.audience === "worker" && f.kind === "operation");
  for (const f of opForms) wrap.append(operationFormBlock(f, c));
  return wrap;
}

function customerForms(m, c) {
  const wrap = h("div", null, h("h3", null, "Available forms"));
  const forms = (m.forms || []).filter((f) => f.audience === "customer");
  if (!forms.length) { wrap.append(h("div", { class: "empty" }, "No customer forms for this registry.")); return wrap; }
  for (const f of forms) {
    if (f.kind === "case") wrap.append(caseFormBlock(f, c));
    else wrap.append(operationFormBlock(f, c));
  }
  return wrap;
}

function caseFormBlock(f, c) {
  const m = meta();
  const subset = f.fieldSubset || m.fields.map((x) => x.name);
  const defs = m.fields.filter((x) => subset.includes(x.name));
  const box = h("div", { class: "card", style: "background:var(--panel-2)" }, h("h3", null, f.title + (f.requiresApproval ? " (needs approval)" : "")));
  for (const d of defs) box.append(h("div", { class: "field" }, h("label", null, d.name), fieldInput(d)));
  box.append(h("button", { class: "btn sm", onclick: async () => {
    const fields = {};
    for (const d of defs) { const val = readField(d); if (val !== undefined) fields[d.name] = val; }
    const r = await api("POST", `/api/registries/${state.registry}/forms/${f.formId}/submit`, { diaryNumber: c.diaryNumber, fields });
    if (ok(r, r.status === 202 ? "Submitted — awaiting worker approval" : "Applied")) render();
  } }, "Submit"));
  return box;
}

function operationFormBlock(f, c) {
  const schema = f.propertySchema || { properties: {}, required: [] };
  const props = Object.entries(schema.properties || {});
  const box = h("div", { class: "card", style: "background:var(--panel-2)" }, h("h3", null, f.title));
  for (const [name, spec] of props) {
    const req = (schema.required || []).includes(name);
    const input = spec.type === "boolean" ? h("select", { id: "op_" + name }, h("option", null, "false"), h("option", null, "true"))
      : h("input", { id: "op_" + name, type: spec.type === "integer" || spec.type === "number" ? "number" : "text" });
    box.append(h("div", { class: "field" }, h("label", null, name, req ? h("span", { class: "req" }, " *") : ""), input));
  }
  if (f.allowAttachments) box.append(h("div", { class: "field" },
    h("label", null, "Attachment filename"), h("input", { id: "op_att_name", placeholder: "deed.txt" }),
    h("label", null, "Attachment text"), h("input", { id: "op_att_body", placeholder: "content" })));
  box.append(h("button", { class: "btn sm", onclick: async () => {
    const properties = {};
    for (const [name, spec] of props) {
      const el = $("#op_" + name); if (!el || el.value === "") continue;
      properties[name] = spec.type === "boolean" ? el.value === "true" : (spec.type === "integer" || spec.type === "number") ? Number(el.value) : el.value;
    }
    const body = { diaryNumber: c.diaryNumber, properties };
    if (f.allowAttachments && $("#op_att_name") && $("#op_att_name").value) {
      body.attachments = [{ filename: $("#op_att_name").value, contentType: "text/plain", base64: btoa($("#op_att_body").value || "") }];
    }
    const r = await api("POST", `/api/registries/${state.registry}/forms/${f.formId}/submit`, body);
    if (ok(r, "Operation recorded")) render();
  } }, "Submit"));
  return box;
}

function categorySelect() {
  return h("select", { id: "cat_sel" }, ...meta().categories.map((c) => h("option", { value: c.code }, `${c.code} — ${c.name}`)));
}
function stateSelect(id) {
  return h("select", { id }, ...meta().states.map((s) => h("option", { value: s.id }, s.name)));
}

boot().catch((e) => { console.error(e); toast("Failed to start: " + e.message, "err"); });
