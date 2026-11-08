# Bridge

HTTP relay between the phone and Foundry. The bridge has no secrets and no Foundry knowledge;
the module inside the world validates the token and does all the work.

```
phone / PWA  --HTTP-->  bridge/server.mjs  <--long-poll--  fc5e-bridge module (GM client)
```

## Run

```
node bridge/server.mjs
```

Prints the port and a `BRIDGE_KEY`. Use `PORT` / `BRIDGE_KEY` to pin them across restarts.

## App

Open `http://<host>:31415` on the phone: pick your player name and type the shared game password.
The page lists the actor's HP/AC, ability checks and saves, skills and items, and every tap calls the
API above — rolls land in Foundry chat, edits are written to the sheet.

## Install the module

In Foundry: **Add-on Modules → Install Module → Manifest URL**:

```
https://github.com/Shinigallo/fc5e-bridge/releases/latest/download/module.json
```

Then enable **FC5e Bridge**.

In the module settings:

- **Bridge URL** — where the GM browser reaches the bridge; must be reachable from the phones too.
- **Bridge key** — the `BRIDGE_KEY` printed at startup.
- **Game password** — the one password the players type on their phone. Required.
- **Tokens** — filled in by the phones (`{"Player2":"<token>"}`). Delete an entry to unlink that player;
  every request is executed as that Foundry user, so actor ownership applies.

## API

All bodies are JSON, all responses are JSON.

| Call | Body | Result |
| --- | --- | --- |
| `GET /api/players` | — | `{players:[{name,claimed}]}` (Foundry players, no token needed) |
| `POST /api/claim` | `{name, password}` | `{token}` — the shared game password unlocks the name once |
| `POST /api/session` | `{token}` | `{user, actors:[{id,name,img,type}]}` |
| `POST /api/actor/:id` | `{token}` | prepared sheet values + item list |
| `POST /api/patch/:id` | `{token, patch}` | updated actor (same shape as above) |
| `POST /api/roll` | `{token, actorId, kind, key}` | `{total, formula}` |

`kind` is `check` (`key` = `str`…), `save`, `skill` (`key` = `ath`…), `death`, or `formula`
(`key` = an arbitrary formula). Rolls run through the native dnd5e methods, so bonuses,
advantage and criticals stay correct and the result appears in chat like any other roll.

`patch` is a flat map of sheet paths. Only these are writable:

```
system.attributes.hp.value|temp|tempmax
system.attributes.death.success|failure
system.attributes.exhaustion
system.attributes.inspiration
system.currency.pp|ep|gp|sp|cp
items.<itemId>.system.quantity|equipped|attuned
items.<itemId>.system.preparation.prepared
```

Anything else is rejected with `400`.

## Test

```
node bridge/selftest.mjs
```
