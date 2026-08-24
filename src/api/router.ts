/**
 * Minimal path router (no dependencies, Node/Bun-compatible).
 *
 * Routes are (method, pattern) where pattern uses :param segments. Matching
 * returns extracted params. Kept deliberately tiny — the platform's REST
 * surface is small and stable, so a full framework is unwarranted here.
 */

import type { HttpMethod } from "./tokens.ts";

export interface RouteMatch {
  readonly params: Readonly<Record<string, string>>;
}

export interface Route<H> {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: H;
  readonly segments: readonly string[];
}

export function defineRoute<H>(method: HttpMethod, pattern: string, handler: H): Route<H> {
  return { method, pattern, handler, segments: pattern.split("/").filter(Boolean) };
}

export function matchRoute<H>(
  routes: readonly Route<H>[],
  method: string,
  path: string,
): { route: Route<H>; match: RouteMatch } | undefined {
  const parts = path.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const seg = route.segments[i]!;
      const val = parts[i]!;
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(val);
      else if (seg !== val) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, match: { params } };
  }
  return undefined;
}
