/**
 * Platform context — wires the stateless request layer to registries.
 *
 * Resolves a registryId to its RegistryDefinition and its Db. In production the
 * Db comes from the registry catalog + connection-cache app (different physical
 * databases, possibly on different servers, D-04); in dev/test a single adapter
 * backs every registry. The rest of the API depends only on this resolution, so
 * multi-database placement is transparent above this line.
 */

import type { DbAdapter } from "../db/db.ts";
import type { RegistryDefinition } from "../config/registry-catalog.ts";
import type { IdentityProvider } from "../auth/identity.ts";
import type { BlobStore } from "../blob/blob.ts";

export interface RegistryHandle {
  readonly def: RegistryDefinition;
  readonly db: DbAdapter;
}

export interface Clock {
  now(): string;
}

export class Platform {
  readonly shared: DbAdapter;
  readonly identity: IdentityProvider;
  readonly clock: Clock;
  readonly blobs: BlobStore;
  #registries = new Map<string, RegistryHandle>();

  constructor(shared: DbAdapter, identity: IdentityProvider, clock: Clock, blobs: BlobStore) {
    this.shared = shared;
    this.identity = identity;
    this.clock = clock;
    this.blobs = blobs;
  }

  registerRegistry(def: RegistryDefinition, db: DbAdapter): void {
    this.#registries.set(def.registryId, { def, db });
  }

  registry(registryId: string): RegistryHandle | undefined {
    return this.#registries.get(registryId);
  }

  /** All registered registries — used by the scheduled export across all. */
  allRegistries(): RegistryHandle[] {
    return [...this.#registries.values()];
  }
}
