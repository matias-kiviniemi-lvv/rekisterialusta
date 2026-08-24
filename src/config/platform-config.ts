/**
 * Platform-wide configuration: the shared category registry and the set of
 * registries hosted on the platform. Adding a registry here (plus its config
 * file) is the whole "stand up a new registry" action — no code change.
 */

import type { PlatformConfig, RegistryConfig } from "./registry-config.ts";
import { PERMIT_CONFIG } from "./registries/permit.ts";
import { GRANT_CONFIG } from "./registries/grant.ts";

export const PLATFORM_CONFIG: PlatformConfig = {
  categories: [
    // Environment / permits
    { code: "105", name: "Environment" },
    { code: "105.04", name: "Water permits" },
    { code: "105.04.03", name: "Small water permits" },
    { code: "200", name: "Building" },
    // Grants
    { code: "300", name: "Grants" },
    { code: "300.01", name: "Culture grants" },
    { code: "300.02", name: "Sport grants" },
  ],
};

export const ALL_REGISTRIES: readonly RegistryConfig[] = [PERMIT_CONFIG, GRANT_CONFIG];
