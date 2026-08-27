/**
 * Platform-wide configuration: the shared category registry and the set of
 * registries hosted on the platform. Adding a registry here (plus its config
 * file) is the whole "stand up a new registry" action — no code change.
 */

import type { PlatformConfig, RegistryConfig } from "./registry-config.ts";
import { PERMIT_CONFIG } from "./registries/permit.ts";
import { GRANT_CONFIG } from "./registries/grant.ts";

export const PLATFORM_CONFIG: PlatformConfig = {
  locales: { supported: ["fi"], default: "fi" },
  categories: [
    // Environment / permits
    { code: "105", name: "Environment", labels: { sourceLocale: "fi", values: { fi: "Ympäristö" } } },
    { code: "105.04", name: "Water permits", labels: { sourceLocale: "fi", values: { fi: "Vesiluvat" } } },
    { code: "105.04.03", name: "Small water permits", labels: { sourceLocale: "fi", values: { fi: "Pienet vesiluvat" } } },
    { code: "200", name: "Building", labels: { sourceLocale: "fi", values: { fi: "Rakentaminen" } } },
    // Grants
    { code: "300", name: "Grants", labels: { sourceLocale: "fi", values: { fi: "Avustukset" } } },
    { code: "300.01", name: "Culture grants", labels: { sourceLocale: "fi", values: { fi: "Kulttuuriavustukset" } } },
    { code: "300.02", name: "Sport grants", labels: { sourceLocale: "fi", values: { fi: "Liikunta-avustukset" } } },
  ],
};

export const ALL_REGISTRIES: readonly RegistryConfig[] = [PERMIT_CONFIG, GRANT_CONFIG];
