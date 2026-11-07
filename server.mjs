import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 31415);
const KEY = process.env.BRIDGE_KEY || randomUUID();
const OP_TIMEOUT = 20_000;
const POLL_MAX = 25_000;

const pending = [];   // ops waiting for a module poll
const waiting = [];   // module polls waiting for an op
const inflight = new Map(); // opId -> resolve

function json(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function need(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`missing ${name}`);
  return value;
}

function enqueue(op, data) {
  const id = randomUUID();
  const result = new Promise(resolve => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      resolve({ status: 504, body: { error: "timeout" } });
    }, OP_TIMEOUT);
    inflight.set(id, { resolve, timer });
  });
  const waiter = waiting.shift();
  const item = { id, op, data };
  if (waiter) {
    clearTimeout(waiter.timer);
    json(waiter.res, 200, item);
  } else {
    pending.push(item);
  }
  return result;
}

function opFor(path, method, data) {
  if (method !== "POST") return null;
  if (path === "/api/session") return { op: "session", data: { token: need(data.token, "token") } };
  if (path === "/api/roll") {
    return {
      op: "roll",
      data: {
        token: need(data.token, "token"),
        actorId: need(data.actorId, "actorId"),
        kind: need(data.kind, "kind"),
        key: need(data.key, "key"),
      },
    };
  }
  const m = /^\/api\/(actor|patch)\/([^/]+)$/.exec(path);
  if (!m) return null;
  const base = { token: need(data.token, "token"), actorId: m[2] };
  if (m[1] === "actor") return { op: "actor", data: base };
  if (!data.patch || typeof data.patch !== "object" || Array.isArray(data.patch)) throw new Error("bad patch");
  return { op: "patch", data: { ...base, patch: data.patch } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    if (path === "/m/poll") {
      if (url.searchParams.get("key") !== KEY) return json(res, 403, { error: "forbidden" });
      const item = pending.shift();
      if (item) return json(res, 200, item);
      const wait = Math.min(Number(url.searchParams.get("wait") ?? 25) * 1000 || POLL_MAX, POLL_MAX);
      const timer = setTimeout(() => {
        const i = waiting.findIndex(w => w.res === res);
        if (i >= 0) waiting.splice(i, 1);
        json(res, 204, {});
      }, wait);
      waiting.push({ res, timer });
      return;
    }

    if (path === "/m/reply") {
      if (url.searchParams.get("key") !== KEY) return json(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const entry = inflight.get(body.id);
      if (!entry) return json(res, 200, { accepted: false });
      inflight.delete(body.id);
      clearTimeout(entry.timer);
      entry.resolve({ status: body.ok ? 200 : 400, body: body.ok ? (body.data ?? {}) : { error: body.error ?? "failed" } });
      return json(res, 200, { accepted: true });
    }

    if (path.startsWith("/api/")) {
      const data = await readBody(req);
      const job = opFor(path, req.method, data);
      if (!job) return json(res, 404, { error: "not found" });
      const { status, body } = await enqueue(job.op, job.data);
      return json(res, status, body);
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, 400, { error: String(error.message ?? error) });
  }
});

server.listen(PORT, () => {
  console.log(`bridge on http://0.0.0.0:${PORT}`);
  console.log(`BRIDGE_KEY=${KEY}`);
});
