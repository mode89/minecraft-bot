# AGENTS.md

This repository implements an AI-powered Minecraft bot as a Pi package.

## Pi extension `extensions/pi-minecraft.js`

- Registers Pi commands for managing background bot runtime process `mcbot.js`.
- Listens to Minecraft chat and routes Minecraft chat messages into Pi as user messages.
- Injects bot-operator instructions `system.md` into Pi's system prompt while the runtime is active.

## Managed Mineflayer runtime `mcbot.js`

Connects a Minecraft bot to a server and exposes HTTP endpoints for AI control:
- `POST /eval`: execute arbitrary JavaScript in a guarded async bot-control context.
- `GET /listen`: stream Minecraft chat events as newline-delimited JSON.

## Operator instructions `system.md`

This is the operator prompt injected into Pi's system prompt while the managed runtime is running:
- It teaches the AI how to control the bot through HTTP.
- Update it whenever runtime capabilities change.
- Keep it written for the AI bot operator, not for repository developers.

## `README.md`

Keep it user-facing and concise.

## Tests

Tests live under `test/` and are runnable with `node --test`.

End-to-end tests under `test/integration` that boot a real Minecraft server and a real `mcbot.js`:
- `fixture.js` exposes `withWorld(map, spawn, body)`, which builds a synthetic block map, spawns a fresh bot, and runs eval requests against it.
- Tests are gated on `INTEGRATION_TESTS=1` so the default `node --test` run skips them.
- `minecraft-server` must be on `PATH` for the fixture to boot.

## Postinstall patches `scripts/patches.js`

Runs as `npm` `postinstall` to patch files under `node_modules/`:
- Defines a `patch(relPath, regex, replacement)` helper. The regex may have one optional capture group; if present, only that group's span is replaced.
- Add a comment near each `patch(...)` call explaining why it is needed.
