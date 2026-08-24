/**
 * Shared HTTP handler types, in their own module so both the core routes and
 * the admin routes can depend on them without an import cycle.
 */

import type { Platform } from "./platform.ts";
import type { Principal } from "./authz.ts";

export interface ApiRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly principal: Principal;
  readonly correlationId: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ApiHandler = (platform: Platform, req: ApiRequest) => Promise<ApiResponse>;
