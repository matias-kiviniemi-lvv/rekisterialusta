/**
 * Config promotion dev → test → prod (Architecture §5.12, Decision D-05).
 *
 * The promotable artifact is the RegistryConfig. On apply it is persisted to
 * config_versions.config_json per environment. Promotion is therefore:
 *   1. exportRegistryConfig(sourceShared, registryId)  — read the artifact,
 *   2. applyRegistryConfig(targetShared, targetRegDb, artifact)  — apply it.
 *
 * Applying the same artifact to another environment yields identical behavior,
 * which is exactly what a promotion must guarantee. Forward-only: apply never
 * drops, only creates/adds/updates.
 */

import type { DbAdapter } from "../db/db.ts";
import type { RegistryConfig } from "../config/registry-config.ts";
import { applyRegistryConfig } from "./config-apply.ts";
import { dialectFor } from "../db/dialect.ts";

export interface ConfigVersionInfo {
  readonly registryId: string;
  readonly version: number;
  readonly appliedAt: string;
  readonly summary: string | null;
}

/** Read the latest applied config artifact for a registry from a shared DB. */
export async function exportRegistryConfig(shared: DbAdapter, registryId: string): Promise<RegistryConfig | undefined> {
  const d = dialectFor(shared.dialect);
  const row = await shared.get(
    d.limitOne("SELECT config_json FROM config_versions WHERE registry_id = ? ORDER BY version DESC"),
    [registryId],
  );
  return row ? (JSON.parse(String(row.config_json)) as RegistryConfig) : undefined;
}

/** List a registry's applied versions (promotion history). */
export async function listConfigVersions(shared: DbAdapter, registryId: string): Promise<ConfigVersionInfo[]> {
  const rows = await shared.all("SELECT registry_id, version, applied_at, summary FROM config_versions WHERE registry_id = ? ORDER BY version", [registryId]);
  return rows.map((r) => ({ registryId: String(r.registry_id), version: Number(r.version), appliedAt: String(r.applied_at), summary: r.summary === null ? null : String(r.summary) }));
}

/**
 * Promote a registry's config from a source environment to a target
 * environment. Reads the artifact from source, applies it to the target's
 * shared + registry databases.
 */
export async function promoteRegistry(
  sourceShared: DbAdapter,
  targetShared: DbAdapter,
  targetRegDb: DbAdapter,
  registryId: string,
  now: string,
): Promise<{ promoted: boolean; version?: number }> {
  const artifact = await exportRegistryConfig(sourceShared, registryId);
  if (!artifact) return { promoted: false };
  const { version } = await applyRegistryConfig(targetShared, targetRegDb, artifact, now);
  return { promoted: true, version };
}
