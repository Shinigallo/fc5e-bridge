import { splitPatch } from "./patch.mjs";

const MOD = "fc5e-bridge";
const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

const ROLLS = {
  check: (actor, key) => actor.rollAbilityCheck({ ability: key }, { configure: false }),
  save: (actor, key) => actor.rollSavingThrow({ ability: key }, { configure: false }),
  skill: (actor, key) => actor.rollSkill({ skill: key }, { configure: false }),
  death: actor => actor.rollDeathSave({}, { configure: false }),
  formula: (actor, key) => new Roll(key).toMessage(),
};

function storeTokens() {
  try {
    return JSON.parse(game.settings.get(MOD, "tokens") ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function resolveUser(token) {
  const exec = storeTokens()[token];
  if (!exec) throw new Error("unknown token");
  const user = exec.startsWith("user:") ? game.users.getName(exec.slice(5)) : game.user;
  if (!user) throw new Error("unknown token");
  return user;
}

/** Picker list: Foundry player accounts when they exist, otherwise the GM's characters
 *  (GM-only worlds have no player accounts; phones then act as the GM). */
function players() {
  const taken = Object.values(storeTokens());
  const nonGm = game.users.filter(u => !u.isGM);
  if (nonGm.length) {
    return nonGm.map(u => ({ name: u.name, claimed: taken.includes(`user:${u.name}`) }));
  }
  return game.actors
    .filter(a => a.testUserPermission(game.user, OWNER))
    .map(a => ({ name: a.name, claimed: false }));
}

/** Bind a picker name to a token, gated by the shared game password. A player account
 *  keeps one token (re-login after a cleared phone); a GM-world character gets a fresh one. */
async function claim(name, password) {
  const expected = game.settings.get(MOD, "gamePassword") ?? "";
  if (!expected) throw new Error("game password not set by the GM");
  if (password !== expected) throw new Error("wrong game password");
  const player = game.users.filter(u => !u.isGM).find(u => u.name === name);
  let exec;
  if (player) {
    exec = `user:${player.name}`;
  } else {
    const actor = game.actors.getName(name);
    if (!actor || !actor.testUserPermission(game.user, OWNER)) throw new Error("unknown character");
    exec = `gm:${name}`;
  }
  const tokens = storeTokens();
  const existing = player ? Object.entries(tokens).find(([, e]) => e === exec) : undefined;
  if (existing) return existing[0];
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  tokens[token] = exec;
  await game.settings.set(MOD, "tokens", JSON.stringify(tokens));
  return token;
}

function ownActor(user, actorId) {
  const actor = game.actors.get(actorId);
  if (!actor || !actor.testUserPermission(user, OWNER)) throw new Error("actor not found");
  return actor;
}

function actorData(actor) {
  const s = actor.system;
  const pick = (obj, fn) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, fn(v)]));
  return {
    id: actor.id,
    name: actor.name,
    img: actor.img,
    hp: s.attributes?.hp,
    ac: s.attributes?.ac?.value ?? s.attributes?.ac,
    abilities: pick(s.abilities, v => ({ mod: v.mod, save: v.save, label: v.label })),
    skills: pick(s.skills, v => ({ total: v.total, ability: v.ability, label: v.label })),
    currencies: s.currency,
    items: actor.items.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      img: i.img,
      quantity: i.system?.quantity,
      equipped: i.system?.equipped,
      attuned: i.system?.attuned,
      prepared: i.system?.preparation?.prepared,
    })),
  };
}

async function applyPatch(actor, patch) {
  const { actorChanges, itemChanges } = splitPatch(patch);
  if (Object.keys(actorChanges).length) await actor.update(actorChanges);
  for (const [id, changes] of Object.entries(itemChanges)) {
    const item = actor.items.get(id);
    if (!item) throw new Error(`no item ${id}`);
    await item.update(changes);
  }
  return actorData(actor);
}

async function handle({ op, data }) {
  try {
    if (op === "players") return { ok: true, data: { players: players() } };
    if (op === "claim") return { ok: true, data: { token: await claim(data.name, data.password) } };
    const user = resolveUser(data.token);
    if (op === "session") {
      const actors = game.actors
        .filter(a => a.testUserPermission(user, OWNER))
        .map(a => ({ id: a.id, name: a.name, img: a.img, type: a.type }));
      return { ok: true, data: { user: user.name, actors } };
    }
    const actor = ownActor(user, data.actorId);
    if (op === "actor") return { ok: true, data: actorData(actor) };
    if (op === "patch") return { ok: true, data: await applyPatch(actor, data.patch) };
    if (op === "roll") {
      const fn = ROLLS[data.kind];
      if (!fn) throw new Error(`unknown roll kind: ${data.kind}`);
      const rolls = await fn(actor, data.key);
      const first = rolls?.[0];
      return { ok: true, data: { total: first?.total ?? null, formula: first?.formula ?? null } };
    }
    throw new Error(`unknown op: ${op}`);
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) };
  }
}

async function loop() {
  const base = (game.settings.get(MOD, "bridgeUrl") ?? "").replace(/\/$/, "");
  const key = encodeURIComponent(game.settings.get(MOD, "bridgeKey") ?? "");
  if (!base) return;
  console.log(`${MOD} | polling ${base}`);
  for (;;) {
    try {
      const res = await fetch(`${base}/m/poll?wait=25&key=${key}`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 204) continue;
      if (!res.ok) throw new Error(`poll ${res.status}`);
      const job = await res.json();
      const reply = await handle(job);
      await fetch(`${base}/m/reply?key=${key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: job.id, ...reply }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.warn(`${MOD} | ${error.message ?? error}`);
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}

Hooks.once("init", () => {
  game.settings.register(MOD, "bridgeUrl", {
    name: "Bridge URL",
    hint: "Address of the Node bridge reachable from this browser.",
    scope: "world", config: true, type: String, default: "http://127.0.0.1:31415",
  });
  game.settings.register(MOD, "bridgeKey", {
    name: "Bridge key",
    hint: "Printed by the bridge at startup (BRIDGE_KEY).",
    scope: "world", config: true, type: String, default: "",
  });
  game.settings.register(MOD, "gamePassword", {
    name: "Game password",
    hint: "Shared password the players type on their phone. Required.",
    scope: "world", config: true, type: String, default: "",
  });
  game.settings.register(MOD, "tokens", {
    name: "Tokens",
    hint: 'JSON map token to identity, e.g. {"abc":"user:Player2"}. Filled in by the phones; delete an entry to unlink that player.',
    scope: "world", config: true, type: String, default: "{}",
  });
});

Hooks.once("ready", () => {
  if (game.user.isGM) loop();
});
