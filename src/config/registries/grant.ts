/**
 * Grant registry — a SECOND, structurally different registry, added purely as
 * configuration (Plan Phase 5). Different fields, states, categories, forms,
 * and rules from the Permit registry, yet it runs on the same engine with no
 * application-code change. This is the platform's core promise made concrete.
 *
 * It lives on its own database (database: "pool-b/grant"), demonstrating the
 * multi-database, multi-server topology.
 */

import type { RegistryConfig } from "../registry-config.ts";

export const GRANT_CONFIG: RegistryConfig = {
  registryId: "grant",
  name: "Grant Registry",
  database: "grant",
  diary: { registryCode: "GRANT", numberPadding: 6, separator: "-" }, // different format
  initialState: "submitted",
  categoryRoots: ["300"],
  version: 1,
  fields: [
    { name: "organisation", type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Identify the applicant", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "amount_requested", type: "decimal", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Assess the application", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "purpose", type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Assess statutory purpose", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "iban", type: "text", nullable: true, writableOnCreate: false, writableOnUpdate: true, publicationEligible: false, legalBasis: "Grant Act", purpose: "Pay an awarded grant", sensitivity: "restricted", retentionPolicy: "payment-plus-6-years" },
  ],
  states: [
    { id: "submitted", name: "Submitted", isOpen: true, isWaitingForCustomer: false },
    { id: "under_review", name: "Under review", isOpen: true, isWaitingForCustomer: false },
    { id: "awaiting_info", name: "Awaiting information", isOpen: true, isWaitingForCustomer: true },
    { id: "granted", name: "Granted", isOpen: true, isWaitingForCustomer: false },
    { id: "rejected", name: "Rejected", isOpen: false, isWaitingForCustomer: false },
    { id: "paid", name: "Paid", isOpen: false, isWaitingForCustomer: false },
  ],
  transitions: [
    ["submitted", "under_review"],
    ["under_review", "awaiting_info"],
    ["awaiting_info", "under_review"],
    ["under_review", "granted"],
    ["under_review", "rejected"],
    ["granted", "paid"],
  ],
  forms: [
    {
      formId: "provide-iban",
      kind: "case",
      audience: "customer",
      title: "Provide payment IBAN",
      requiresApproval: false,
      fieldSubset: ["iban"],
    },
    {
      formId: "submit-receipt",
      kind: "operation",
      audience: "customer",
      title: "Submit a receipt",
      operationType: "receipt",
      allowAttachments: true,
      propertySchema: {
        type: "object",
        properties: { amount: { type: "number" }, note: { type: "string" } },
        required: ["amount"],
        additionalProperties: false,
      },
    },
  ],
  rules: [
    { ruleId: "notify-on-awaiting", onToState: "awaiting_info", condition: null, actionType: "notify_customer", actionParams: { template: "info_needed" } },
    { ruleId: "flag-large-grants", onToState: "granted", condition: { field: "amount_requested", notEquals: 0 }, actionType: "create_operation", actionParams: { direction: "internal", type: "audit_flag", comment: "Granted — routed to audit" } },
  ],
};
