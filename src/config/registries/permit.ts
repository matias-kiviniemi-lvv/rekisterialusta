/**
 * Permit registry — declarative config (config-as-code).
 * The same registry that earlier phases hardcoded, now expressed as data.
 */

import type { RegistryConfig } from "../registry-config.ts";

export const PERMIT_CONFIG: RegistryConfig = {
  registryId: "permit",
  name: "Permit Registry",
  labels: { sourceLocale: "fi", values: { fi: "Luparekisteri" } },
  database: "permit",
  diary: { registryCode: "PERMIT", numberPadding: 5, separator: "/" },
  initialState: "received",
  categoryRoots: ["105", "200"],
  version: 1,
  fields: [
    { name: "applicant_name", labels: { sourceLocale: "fi", values: { fi: "Hakijan nimi" } }, type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Permit Act", purpose: "Identify the applicant", sensitivity: "normal", retentionPolicy: "case-lifecycle" },
    { name: "permit_kind", labels: { sourceLocale: "fi", values: { fi: "Luvan tyyppi" } }, type: "text", nullable: false, writableOnCreate: true, writableOnUpdate: false, publicationEligible: true, legalBasis: "Permit Act", purpose: "Classify the application", sensitivity: "public", retentionPolicy: "case-lifecycle" },
    { name: "site_address", labels: { sourceLocale: "fi", values: { fi: "Kohteen osoite" } }, type: "text", nullable: true, writableOnCreate: true, writableOnUpdate: true, publicationEligible: true, legalBasis: "Permit Act", purpose: "Locate the activity", sensitivity: "normal", retentionPolicy: "case-lifecycle" },
    { name: "fee_paid", labels: { sourceLocale: "fi", values: { fi: "Maksu maksettu" } }, type: "boolean", nullable: false, writableOnCreate: true, writableOnUpdate: true, publicationEligible: false, legalBasis: "Fees Act", purpose: "Track payment", sensitivity: "restricted", retentionPolicy: "case-lifecycle" },
  ],
  states: [
    { id: "received", name: "Received", labels: { sourceLocale: "fi", values: { fi: "Vastaanotettu" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "in_preparation", name: "In preparation", labels: { sourceLocale: "fi", values: { fi: "Valmistelussa" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "waiting_customer", name: "Waiting for customer", labels: { sourceLocale: "fi", values: { fi: "Odottaa asiakasta" } }, isOpen: true, isWaitingForCustomer: true },
    { id: "decided", name: "Decided", labels: { sourceLocale: "fi", values: { fi: "Päätetty" } }, isOpen: true, isWaitingForCustomer: false },
    { id: "closed", name: "Closed", labels: { sourceLocale: "fi", values: { fi: "Suljettu" } }, isOpen: false, isWaitingForCustomer: false },
  ],
  transitions: [
    ["received", "in_preparation"],
    ["in_preparation", "waiting_customer"],
    ["waiting_customer", "in_preparation"],
    ["in_preparation", "decided"],
    ["decided", "closed"],
  ],
  caseForms: [
    {
      formId: "update-site-address",
      audience: "customer",
      title: "Update site address",
      description: "Enter the new address for the permit site.",
      descriptions: { sourceLocale: "fi", values: { fi: "Anna lupakohteen uusi osoite." } },
      titles: { sourceLocale: "fi", values: { fi: "Päivitä kohteen osoite" } },
      requiresApproval: true,
      fieldSubset: ["site_address"],
    },
  ],
  operationForms: [
    {
      formId: "submit-document",
      audience: "customer",
      title: "Submit a supporting document",
      description: "Describe and attach the supporting document.",
      descriptions: { sourceLocale: "fi", values: { fi: "Kuvaile ja liitä täydentävä asiakirja." } },
      titles: { sourceLocale: "fi", values: { fi: "Toimita liiteasiakirja" } },
      operationType: "document",
      allowAttachments: true,
      propertySchema: {
        type: "object",
        properties: { documentTitle: { type: "string" }, pages: { type: "integer" } },
        required: ["documentTitle"],
        additionalProperties: false,
      },
    },
  ],
  rules: [
    { ruleId: "notify-on-waiting", onToState: "waiting_customer", condition: null, actionType: "notify_customer", actionParams: { template: "action_required" } },
    { ruleId: "autoclose-paid-decisions", onToState: "decided", condition: { field: "fee_paid", equals: true }, actionType: "set_state", actionParams: { toState: "closed" } },
  ],
};
