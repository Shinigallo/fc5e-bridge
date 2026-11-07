import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { splitPatch } from "./module/patch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 31500 + Math.floor(Math.random() * 400);
const KEY = "selftest-key";
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), BRIDGE_KEY: KEY },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise(resolve => server.stdout.once("data", resolve));

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  }).then(async r => ({ status: r.status, body: await r.json() }));

// A fake Foundry module: takes one op and answers it.
async function serveOne(reply) {
  const poll = await fetch(`${base}/m/poll?wait=2&key=${KEY}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(poll.status, 200, "module poll should hand back the queued op");
  const job = await poll.json();
  const r = await post(`/m/reply?key=${KEY}`, { id: job.id, ...reply });
  assert.deepEqual(r.body, { accepted: true });
  return job;
}

try {
  // 0. the write allow-list is the security boundary
  assert.deepEqual(splitPatch({ "system.attributes.hp.value": 5, "items.abc.system.quantity": 2 }), {
    actorChanges: { "system.attributes.hp.value": 5 },
    itemChanges: { abc: { "system.quantity": 2 } },
  });
  assert.throws(() => splitPatch({ "system.attributes.hp.max": 99 }), /not allowed/);
  assert.throws(() => splitPatch({ "system.name": "x" }), /not allowed/);
  assert.throws(() => splitPatch({ "system.attributes.hp.value": "5" }), /bad value/);

  // 1. the module endpoints reject a missing key
  const forbidden = await fetch(`${base}/m/poll?wait=0.1`);
  assert.equal(forbidden.status, 403);

  // 1b. the phone page is served
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<main id="app">/);
  assert.equal((await fetch(`${base}/app/../server.mjs`)).status, 404);

  // 2. session: request resolves with what the module replied
  const session = post("/api/session", { token: "t1" });
  const job = await serveOne({ ok: true, data: { user: "Player2", actors: [{ id: "a", name: "Aelar" }] } });
  assert.equal(job.op, "session");
  assert.equal(job.data.token, "t1");
  assert.deepEqual((await session).body, { user: "Player2", actors: [{ id: "a", name: "Aelar" }] });

  // 3. patch: path params and body reach the module
  const patch = post("/api/patch/abc123", { token: "t1", patch: { "system.attributes.hp.value": 5 } });
  const patchJob = await serveOne({ ok: true, data: { id: "abc123", hp: { value: 5 } } });
  assert.equal(patchJob.op, "patch");
  assert.equal(patchJob.data.actorId, "abc123");
  assert.deepEqual(patchJob.data.patch, { "system.attributes.hp.value": 5 });
  assert.equal((await patch).status, 200);

  // 4. module rejects -> the app sees the reason
  const bad = post("/api/patch/abc123", { token: "t1", patch: { "system.attributes.hp.max": 99 } });
  await serveOne({ ok: false, error: "not allowed: system.attributes.hp.max" });
  const badResult = await bad;
  assert.equal(badResult.status, 400);
  assert.equal(badResult.body.error, "not allowed: system.attributes.hp.max");

  // 5. roll relay keeps the key, not a number
  const roll = post("/api/roll", { token: "t1", actorId: "abc123", kind: "skill", key: "ath" });
  const rollJob = await serveOne({ ok: true, data: { total: 17, formula: "1d20+5" } });
  assert.deepEqual(rollJob.data, { token: "t1", actorId: "abc123", kind: "skill", key: "ath" });
  assert.deepEqual((await roll).body, { total: 17, formula: "1d20+5" });

  // 6. unknown replies are not errors
  const ghost = await post(`/m/reply?key=${KEY}`, { id: "nope", ok: true });
  assert.deepEqual(ghost.body, { accepted: false });

  // 7. malformed input is rejected early
  assert.equal((await post("/api/session", {})).status, 400);
  assert.equal((await post("/api/patch/abc", { token: "t1" })).status, 400);
  assert.equal((await post("/api/nope", {})).status, 404);

  console.log("bridge selftest: 11 checks ok");
} finally {
  server.kill();
}
