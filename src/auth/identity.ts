/**
 * Identity federation (Architecture §6.1, Decision D-12).
 *
 * The platform AUTHORIZES but does not ISSUE identities: it federates to a
 * citizen identity provider (eID/OIDC) and a staff provider (directory/SSO).
 * Those integrations are the OPEN item D-12. To keep everything else building
 * (Plan Phase 2), this defines the provider interface and a StubIdentityProvider
 * that maps dev bearer tokens to actors. Swapping in real OIDC/SSO providers is
 * implementing this interface — no change to the authorization model, which is
 * provider-independent.
 */

import type { Actor } from "../core/handler.ts";

export interface IdentityProvider {
  /**
   * Resolve a bearer credential to an authenticated actor, or undefined if the
   * credential is not valid. Never throws for a bad token — returns undefined.
   */
  resolve(bearer: string): Actor | undefined;
}

/**
 * Dev/test identity: bearer tokens of the form
 *   "customer:<customerId>"  or  "worker:<workerId>"
 * map directly to actors. This is the D-12 fallback that unblocks Phase 2; it
 * MUST NOT be used in production.
 */
export class StubIdentityProvider implements IdentityProvider {
  resolve(bearer: string): Actor | undefined {
    const [kind, id] = bearer.split(":", 2);
    if (kind === "customer" && id) return { kind: "customer", customerId: id };
    if (kind === "worker" && id) return { kind: "worker", workerId: id };
    return undefined;
  }
}
