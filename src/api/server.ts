/**
 * HTTP surface (Architecture §1, §13).
 *
 * A thin, STATELESS adapter from node:http to the route handlers. It parses the
 * request, resolves the principal from the Authorization header, dispatches, and
 * writes a JSON response. It holds no state — every request is self-contained,
 * so this scales horizontally (Flex Functions in production). Using node:http
 * keeps it dependency-free and Bun-compatible (D-11).
 *
 * `dispatch` is exported separately so tests can exercise the full routing +
 * authorization + domain stack without opening a socket.
 */

import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize, extname, join } from "node:path";
import type { Platform } from "./platform.ts";
import { matchRoute } from "./router.ts";
import { routes, type ApiRequest, type ApiResponse } from "./routes.ts";
import { resolvePrincipal } from "./authz.ts";
import { randomUUID } from "node:crypto";
import { trustZoneAllows, type TrustZone } from "./trust-zones.ts";

export interface RawRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string | undefined;
  readonly body: unknown;
  readonly correlationId?: string;
  readonly acceptLanguage?: string | undefined;
  readonly trustZone?: TrustZone;
}

export interface HttpLogger {
  info(message: string): void;
  error(message: string): void;
}

const defaultHttpLogger: HttpLogger = {
  info: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

/** Pure dispatch: raw request → response. No sockets. */
export async function dispatch(platform: Platform, raw: RawRequest): Promise<ApiResponse> {
  const url = new URL(raw.url, "http://internal");
  const matched = matchRoute(routes, raw.method, url.pathname);
  if (!matched) return { status: 404, body: { error: "no such route" } };
  const principal = await resolvePrincipal(platform, raw.authorization);
  if (!trustZoneAllows(raw.trustZone ?? "combined", raw.method, url.pathname, principal)) {
    return { status: 404, body: { error: "no such route" } };
  }
  const req: ApiRequest = {
    params: matched.match.params,
    query: url.searchParams,
    body: raw.body,
    principal,
    correlationId: raw.correlationId ?? randomUUID(),
    acceptLanguage: raw.acceptLanguage,
  };
  try {
    return await matched.route.handler(platform, req);
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

// The SPA lives in <project>/public; this file is <project>/src/api/server.ts.
const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Serve a static file from PUBLIC_DIR; returns true if handled. */
function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden"); // path traversal guard
    return true;
  }
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const type = CONTENT_TYPES[extname(full)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(full));
  return true;
}

export function createServer(platform: Platform, logger: HttpLogger = defaultHttpLogger, options: { trustZone?: TrustZone; maxBodyBytes?: number } = {}): Server {
  return httpCreateServer((httpReq: IncomingMessage, httpRes: ServerResponse) => {
    const method = httpReq.method ?? "GET";
    const path = (httpReq.url ?? "/").split("?")[0] ?? "/";
    // Non-API GETs are served from the SPA; unknown paths fall back to the app
    // shell so client-side navigation works.
    if (method === "GET" && !path.startsWith("/api/")) {
      if (serveStatic(path, httpRes)) return;
      if (serveStatic("/index.html", httpRes)) return;
      httpRes.writeHead(404).end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    httpReq.on("data", (c: Buffer) => {
      received += c.byteLength;
      if (received > maxBodyBytes) {
        tooLarge = true;
        writeJson(httpRes, { status: 413, body: { error: "request body too large" } });
        httpReq.destroy();
        return;
      }
      chunks.push(c);
    });
    httpReq.on("end", async () => {
      if (tooLarge) return;
      let body: unknown = undefined;
      if (chunks.length > 0) {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          writeJson(httpRes, { status: 400, body: { error: "invalid JSON body" } });
          return;
        }
      }
      const result = await dispatch(platform, {
        method: httpReq.method ?? "GET",
        url: httpReq.url ?? "/",
        authorization: httpReq.headers["authorization"],
        body,
        correlationId: typeof httpReq.headers["x-correlation-id"] === "string" ? httpReq.headers["x-correlation-id"] : randomUUID(),
        acceptLanguage: typeof httpReq.headers["accept-language"] === "string" ? httpReq.headers["accept-language"] : undefined,
        trustZone: options.trustZone ?? "combined",
      });
      logApiResult(logger, method, httpReq.url ?? "/", result);
      writeJson(httpRes, result);
    });
  });
}

function logApiResult(logger: HttpLogger, method: string, url: string, result: ApiResponse): void {
  const path = url.split("?")[0] ?? "/";
  const body = result.body && typeof result.body === "object"
    ? result.body as Record<string, unknown>
    : undefined;
  const detail = typeof body?.error === "string" ? ` — ${body.error}` : "";
  const message = `[http] ${method} ${path} -> ${result.status}${detail}`;
  if (result.status >= 400) logger.error(message);
  else logger.info(message);
}

function writeJson(res: ServerResponse, result: ApiResponse): void {
  // BigInt-safe: internal keys are bigint; serialize them as numbers (case
  // keys are well within Number's safe range). Handlers already convert on the
  // hot paths — this is a defensive net so no bigint ever crashes a response.
  const payload = JSON.stringify(result.body, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
  res.end(payload);
}
