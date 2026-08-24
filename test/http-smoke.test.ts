import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { createServer } from "../src/api/server.ts";

const NOW = "2026-08-11T09:00:00.000Z";

// Verifies the real node:http path (sockets, body parsing, JSON responses),
// not just the pure dispatch function the other suites use.
test("HTTP server serves the API over a real socket", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const messages: string[] = [];
  const server = createServer(platform, {
    info: (message) => messages.push(message),
    error: (message) => messages.push(message),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Create a case as a worker (stub identity).
    const created = await fetch(`${base}/api/registries/permit/cases`, {
      method: "POST",
      headers: { authorization: "Bearer worker:w-anna", "content-type": "application/json" },
      body: JSON.stringify({ category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: true } }),
    });
    assert.equal(created.status, 201);
    const { diaryNumber } = (await created.json()) as { diaryNumber: string };
    assert.match(diaryNumber, /^PERMIT\/2026\/\d{5}$/);

    // Read it back as the same worker.
    const read = await fetch(`${base}/api/registries/permit/cases/${encodeURIComponent(diaryNumber)}`, {
      headers: { authorization: "Bearer worker:w-anna" },
    });
    assert.equal(read.status, 200);
    const payload = (await read.json()) as { case: { diaryNumber: string }; history: unknown[] };
    assert.equal(payload.case.diaryNumber, diaryNumber);
    assert.equal(payload.history.length, 1);

    // Public read of the unpublished case is forbidden.
    const pub = await fetch(`${base}/api/registries/permit/cases/${encodeURIComponent(diaryNumber)}`);
    assert.equal(pub.status, 403);
    assert.ok(messages.some((message) => message.includes("POST /api/registries/permit/cases -> 201")));
    assert.ok(messages.some((message) => message.includes("-> 403 — forbidden")));
  } finally {
    server.closeAllConnections(); // drop fetch keep-alive sockets so close() resolves promptly
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
