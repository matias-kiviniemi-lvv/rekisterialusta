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
  labels: { sourceLocale: "fi", values: { fi: "Avustusrekisteri" } },
  database: "grant",
  diary: { registryCode: "GRANT", numberPadding: 6, separator: "-" }, // different format
  initialState: "submitted",
  categoryRoots: ["300"],
  version: 1,
  fields: [
    { name: "organisation", labels: { sourceLocale: "fi", values: { fi: "Organisaatio" } }, type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Identify the applicant", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "amount_requested", labels: { sourceLocale: "fi", values: { fi: "Haettu määrä" } }, type: "decimal", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Assess the application", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "purpose", labels: { sourceLocale: "fi", values: { fi: "Käyttötarkoitus" } }, type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Grant Act", purpose: "Assess statutory purpose", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "iban", labels: { sourceLocale: "fi", values: { fi: "IBAN-tilinumero" } }, type: "text", nullable: true, writableOnCreate: false, writableOnUpdate: true, publicationEligible: false, legalBasis: "Grant Act", purpose: "Pay an awarded grant", sensitivity: "restricted", retentionPolicy: "payment-plus-6-years" },
  ],
  states: [
    { id: "submitted", name: "Submitted", labels: { sourceLocale: "fi", values: { fi: "Lähetetty" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "under_review", name: "Under review", labels: { sourceLocale: "fi", values: { fi: "Käsittelyssä" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "awaiting_info", name: "Awaiting information", labels: { sourceLocale: "fi", values: { fi: "Odottaa lisätietoja" } }, isOpen: true, isWaitingForCustomer: true },
    { id: "granted", name: "Granted", labels: { sourceLocale: "fi", values: { fi: "Myönnetty" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "rejected", name: "Rejected", labels: { sourceLocale: "fi", values: { fi: "Hylätty" } }, isOpen: false, isWaitingForCustomer: false },
    { id: "paid", name: "Paid", labels: { sourceLocale: "fi", values: { fi: "Maksettu" } }, isOpen: false, isWaitingForCustomer: false },
  ],
  transitions: [
    ["submitted", "under_review"],
    ["under_review", "awaiting_info"],
    ["awaiting_info", "under_review"],
    ["under_review", "granted"],
    ["under_review", "rejected"],
    ["granted", "paid"],
  ],
  caseForms: [
    {
      formId: "provide-iban",
      audience: "customer",
      title: "Provide payment IBAN",
      description: "Enter the bank account used for the grant payment.",
      descriptions: { sourceLocale: "fi", values: { fi: "Anna avustuksen maksamiseen käytettävä pankkitili." } },
      titles: { sourceLocale: "fi", values: { fi: "Anna maksutilin IBAN" } },
      requiresApproval: false,
      fieldSubset: ["iban"],
    },
  ],
  operationForms: [
    {
      formId: "submit-receipt",
      audience: "customer",
      title: "Submit a receipt",
      description: "Enter the receipt details and attach the receipt.",
      descriptions: { sourceLocale: "fi", values: { fi: "Anna kuitin tiedot ja liitä kuitti." } },
      titles: { sourceLocale: "fi", values: { fi: "Toimita kuitti" } },
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
