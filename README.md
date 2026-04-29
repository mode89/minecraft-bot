# pi-minecraft

AI-powered Minecraft bot for Pi.

This package adds Pi commands that manage a background Mineflayer runtime (`mcbot.js`) and inject Minecraft bot-operator instructions (`system.md`) while the runtime is active. Pi then controls the bot through the runtime's local HTTP API.

## Usage

Install this repository as a Pi package:

```sh
pi install .
```

Then restart Pi or run `/reload`.

Commands:

```text
/minecraft:start [mcbot args]
/minecraft:status
/minecraft:stop
```

Once the runtime is started, you can operate the bot either through Pi chat or through normal Minecraft chat. Minecraft chat messages from other players are forwarded into Pi as user messages.

In Minecraft chat, the token `@aim` is replaced with the `(x, y, z)` of the block you are currently looking at, so you can say things like `mine @aim` or `place a torch on @aim`.

Example:

```text
/minecraft:start --server localhost:25565 --http localhost:3000
collect some wood
/minecraft:stop
```

The background process writes state and logs under `.pi/minecraft/` in the current project.

## User snippets

Users may define `.pi/minecraft/snippets.js` as a local CommonJS helper library for reusable bot code. The runtime reloads this file before each `/eval` request and exposes its exports to eval scripts as `snippets`.

Example:

```js
// .pi/minecraft/snippets.js
exports.countItem = (bot, name) => bot.inventory
  .items()
  .filter((item) => item.name === name)
  .reduce((total, item) => total + item.count, 0)
```

Then an eval script can use:

```js
print("oak_log", snippets.countItem(bot, "oak_log"))
```

If the file is missing, `snippets` is an empty object. If it exists but fails to load, the eval request fails with the import error. Keep snippet module load side-effect-free; define helpers only, and pass `bot` or other eval-scope values into helpers explicitly.

## Development

```sh
node --test
```

## Security

The managed bot runtime executes arbitrary JavaScript received over HTTP. Keep `--http` bound to localhost unless you fully trust the network. Game/world changes made by scripts are real and are not rolled back.
