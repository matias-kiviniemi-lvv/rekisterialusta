/**
 * API token store and verification (Architecture §7, Decision D-07 auth).
 *
 * REST tokens carry a scope of allowed HTTP methods × category subtree ×
 * resource. Verification uses the SAME category prefix-containment logic as
 * worker grants, so human and machine authorization share one implementation.
 * Raw tokens are never stored — only a hash (§14).
 *
 * Hashing uses node:crypto (available on Node and Bun). The token store is the
 * shared DB; minting returns the raw token ONCE to the caller.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";
import { normalizePath } from "../domain/categories.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface TokenScope {
  readonly tokenId: string;
  readonly registryId: string;
  readonly methods: ReadonlySet<HttpMethod>;
  readonly resources: ReadonlySet<string>;
  readonly categoryScope: string | null;
  readonly publishedOnly: boolean;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MintInput {
  readonly registryId: string;
  readonly description?: string;
  readonly methods: readonly HttpMethod[];
  readonly resources: readonly string[];
  readonly categoryScope?: string;
  readonly publishedOnly?: boolean;
}

/** Mint a token; returns {tokenId, raw}. The raw value is shown only here. */
export async function mintApiToken(shared: Db, input: MintInput, now: string): Promise<{ tokenId: string; raw: string }> {
  const tokenId = "tok_" + randomBytes(6).toString("hex");
  const raw = "rk_" + randomBytes(24).toString("hex");
  if (input.categoryScope) normalizePath(input.categoryScope); // validate shape
  await shared.run(
    `INSERT INTO api_tokens
      (token_id, token_hash, description, registry_id, methods, resources, category_scope, published_only, active, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      tokenId,
      hashToken(raw),
      input.description ?? null,
      input.registryId,
      input.methods.join(","),
      input.resources.join(","),
      input.categoryScope ?? null,
      input.publishedOnly === false ? 0 : 1,
      now,
    ],
  );
  return { tokenId, raw };
}

/** Look up an active token by its raw value; undefined if unknown/revoked. */
export async function verifyApiToken(shared: Db, raw: string): Promise<TokenScope | undefined> {
  const row = await shared.get(
    "SELECT token_id, registry_id, methods, resources, category_scope, published_only FROM api_tokens WHERE token_hash = ? AND active = 1",
    [hashToken(raw)],
  );
  if (!row) return undefined;
  return {
    tokenId: String(row.token_id),
    registryId: String(row.registry_id),
    methods: new Set(String(row.methods).split(",").filter(Boolean) as HttpMethod[]),
    resources: new Set(String(row.resources).split(",").filter(Boolean)),
    categoryScope: row.category_scope === null ? null : String(row.category_scope),
    publishedOnly: Number(row.published_only) === 1,
  };
}

/**
 * Does the token permit `method` on `resource`, and (if a category is given) is
 * that category within the token's category scope (prefix containment)?
 */
export function tokenAllows(
  scope: TokenScope,
  method: HttpMethod,
  resource: string,
  category?: string,
): boolean {
  if (!scope.methods.has(method)) return false;
  if (!scope.resources.has(resource)) return false;
  if (scope.categoryScope && category) {
    if (!normalizePath(category).startsWith(normalizePath(scope.categoryScope))) return false;
  }
  return true;
}
