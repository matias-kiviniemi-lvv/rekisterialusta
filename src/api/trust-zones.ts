import type { Principal } from "./authz.ts";

export type TrustZone = "combined" | "public" | "worker" | "integration";

/**
 * Network-facing route boundary. Authorization still runs inside every command,
 * but a public deployment never exposes worker/admin paths and an integration
 * deployment never accepts human principals.
 */
export function trustZoneAllows(zone: TrustZone, method: string, path: string, principal: Principal): boolean {
  if (zone === "combined") return true;
  if (zone === "integration") {
    if (principal.kind !== "token") return false;
    return !path.includes("/worker/") && !path.startsWith("/api/admin/") && !path.includes("/forms/") && !path.includes("/pending/");
  }
  if (zone === "worker") {
    if (principal.kind !== "actor" || principal.actor.kind !== "worker") return false;
    return path.startsWith("/api/admin/") || path.startsWith("/api/registries/") || (method === "GET" && path === "/api/registries");
  }
  // Internet/customer/public surface. Worker commands and machine tokens are
  // intentionally unreachable even if a credential leaks into this zone.
  if (principal.kind === "token" || (principal.kind === "actor" && principal.actor.kind === "worker")) return false;
  return !path.startsWith("/api/admin/") && !path.includes("/worker/") && !path.endsWith("/assign") && !path.endsWith("/transition") && !path.endsWith("/publish") && !path.includes("/pending/");
}
