/**
 * Blob storage abstraction (Architecture §11, Decision D-10).
 *
 * File attachments live in object storage (Azure Blob / S3 in production); the
 * relational DB keeps only a reference. This interface is the seam; a dev
 * in-memory adapter backs it locally. Keys are namespaced by registry/case/
 * operation so lifecycle and access are traceable to a case.
 */

import { createHash, randomBytes } from "node:crypto";

export interface StoredBlob {
  readonly key: string;
  readonly size: number;
  readonly checksum: string;
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array): StoredBlob;
  get(key: string): Uint8Array | undefined;
  delete(key: string): void;
}

export function blobKey(registryId: string, caseKey: bigint, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const unique = randomBytes(6).toString("hex");
  return `${registryId}/${caseKey}/${unique}/${safe}`;
}

export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** In-memory dev/test BlobStore. Not for production. */
export class MemoryBlobStore implements BlobStore {
  #data = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): StoredBlob {
    this.#data.set(key, bytes);
    return { key, size: bytes.byteLength, checksum: checksumOf(bytes) };
  }
  get(key: string): Uint8Array | undefined {
    return this.#data.get(key);
  }
  delete(key: string): void {
    this.#data.delete(key);
  }
}
