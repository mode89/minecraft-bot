// Integration-test fixture.
//
// `withWorld(map, spawn, body)` sets up a synthetic world on a shared
// integration Minecraft server, spawns a fresh `mcbot.js` connected to it, and
// runs `body(eval)` against the bot.
//
// Map shape: `map[z][x]` is one of:
//   - a Minecraft block name (single block at y=0),
//   - an array of block names stacked from y=0 up,
//   - null / "" / "air" (empty column).
// Block names without a namespace get `minecraft:` prepended.
//
// The body callback receives an `eval(code)` async function that POSTs
// `code` to mcbot's /eval endpoint and returns the printed output. The code
// runs with two extra bindings injected by withWorld:
//   ORIGIN          - the {x, y, z} world coords of map cell (0, 0, 0)
//   world(x, y, z)  - translate map-local block coords to world coords
//
// The Minecraft server is shared across all callers in the test process (one
// per file under `node --test`'s default isolation): it boots on first call,
// and a module-level `test.after` stops it after all tests in the file
// complete. The mcbot.js subprocess is fresh for each call so per-test state
// never leaks.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// ---------------------------------------------------------------------------
// withWorld

// Fixed arena large enough for typical pathing scenarios while still fitting
// inside one /fill command (max 32768 blocks). Origin is far from world
// spawn so the bot never accidentally sees default-generated terrain.
const ORIGIN = { x: 1000, y: 0, z: 1000 };
const SIZE = { x: 32, y: 16, z: 32 };

async function withWorld(map, spawn_, body) {
  validateMap(map);

  const server = await startServer();
  await forceloadArena(server);
  await clearArena(server);
  await buildMap(server, map);

  const bot = await startBot(server);
  try {
    await teleportBot(server, spawn_);
    await waitForBotReady(bot.eval, spawn_);
    return await body(makeEval(bot.eval));
  } finally {
    await bot.stop();
  }
}

// ---------------------------------------------------------------------------
// Map -> server commands

function validateMap(map) {
  if (!Array.isArray(map)) throw new TypeError("map must be a 2D array");
  if (map.length > SIZE.z) {
    throw new RangeError(`map z=${map.length} exceeds arena ${SIZE.z}`);
  }
  for (let z = 0; z < map.length; z++) {
    const row = map[z];
    if (!Array.isArray(row)) {
      throw new TypeError(`map[${z}] must be an array`);
    }
    if (row.length > SIZE.x) {
      throw new RangeError(`map[${z}] x=${row.length} exceeds arena ${SIZE.x}`);
    }
    for (let x = 0; x < row.length; x++) {
      const column = columnOf(row[x]);
      if (column.length > SIZE.y) {
        throw new RangeError(
          `map[${z}][${x}] y=${column.length} exceeds arena ${SIZE.y}`,
        );
      }
    }
  }
}

// /fill and /setblock silently no-op on unloaded chunks; force-load the
// arena so block-edit commands take effect before the bot teleports in.
async function forceloadArena(server) {
  await server.sendCommand(
    `forceload add ${ORIGIN.x} ${ORIGIN.z} `
      + `${ORIGIN.x + SIZE.x - 1} ${ORIGIN.z + SIZE.z - 1}`,
  );
  await server.barrier();
}

async function clearArena(server) {
  await server.sendCommand(
    `fill ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z} `
      + `${ORIGIN.x + SIZE.x - 1} `
      + `${ORIGIN.y + SIZE.y - 1} `
      + `${ORIGIN.z + SIZE.z - 1} `
      + `air`,
  );
  await server.barrier();
}

async function buildMap(server, map) {
  for (let z = 0; z < map.length; z++) {
    const row = map[z];
    for (let x = 0; x < row.length; x++) {
      const column = columnOf(row[x]);
      for (let y = 0; y < column.length; y++) {
        const id = blockId(column[y]);
        if (id === null) continue;
        await server.sendCommand(
          `setblock ${ORIGIN.x + x} ${ORIGIN.y + y} ${ORIGIN.z + z} ${id}`,
        );
      }
    }
  }
  await server.barrier();
}

// Translate a cell into a y-stacked column of names (with empties as null).
function columnOf(cell) {
  if (cell == null) return [];
  if (Array.isArray(cell)) return cell;
  return [cell];
}

// Resolve a name to a namespaced id, or null if the cell is air.
function blockId(name) {
  if (name == null || name === "" || name === "air") return null;
  return name.includes(":") ? name : `minecraft:${name}`;
}

async function teleportBot(server, spawn_) {
  await server.sendCommand(
    `tp ${BOT_USERNAME} `
      + `${ORIGIN.x + spawn_.x} ${ORIGIN.y + spawn_.y} ${ORIGIN.z + spawn_.z}`,
  );
  await server.barrier();
}

// Block until the /tp position update has landed and the spawn chunk's
// blocks are queryable; otherwise the body's first eval sees an empty world.
async function waitForBotReady(rawEval, spawn_) {
  const target = {
    x: ORIGIN.x + spawn_.x,
    y: ORIGIN.y + spawn_.y,
    z: ORIGIN.z + spawn_.z,
  };
  await rawEval(`
    const target = ${JSON.stringify(target)};
    const deadline = Date.now() + 30000;
    while (true) {
      const p = bot.entity.position;
      const settled
        = Math.abs(p.x - target.x) < 0.01
        && Math.abs(p.y - target.y) < 0.01
        && Math.abs(p.z - target.z) < 0.01;
      const here = bot.blockAt(new Vec3(target.x, target.y, target.z));
      if (settled && here) break;
      if (Date.now() > deadline) {
        throw new Error(
          "bot did not settle at " + JSON.stringify(target)
            + " within 30s (pos=" + JSON.stringify(p)
            + ", blockAt=" + (here ? here.name : "null") + ")",
        );
      }
      await sleep(50);
    }
  `);
}

// ---------------------------------------------------------------------------
// Eval prelude

// Wrap mcbot's raw eval to inject ORIGIN and a `world(x, y, z)` translator,
// so test scripts can write block coords in arena-local space.
function makeEval(rawEval) {
  const prelude
    = `const ORIGIN = ${JSON.stringify(ORIGIN)};\n`
    + `const world = (x, y, z) => `
    + `({ x: ORIGIN.x + x, y: ORIGIN.y + y, z: ORIGIN.z + z });\n`;
  return (code) => rawEval(prelude + code);
}

// ---------------------------------------------------------------------------
// Server lifecycle
//
// The returned handle is intentionally minimal: callers interact with the
// server only through `sendCommand` (write a console line) and `barrier`
// (wait for the server to drain everything sent so far).

const BOT_USERNAME = "mcbot-test";
const SERVER_READY_RE = /\]: Done \([^)]+\)! For help, type "help"/;
const SERVER_START_TIMEOUT_MS = 180_000;
const SERVER_STOP_TIMEOUT_MS = 30_000;
const BARRIER_TIMEOUT_MS = 30_000;

let serverPromise = null;

// After all tests in this file run, stop the shared server if it was started.
test.after(async () => {
  if (!serverPromise) return;
  const handle = await serverPromise.catch(() => null);
  serverPromise = null;
  if (handle) await stopServer(handle);
});

// Boot (or return) the shared server. Idempotent.
async function startServer() {
  if (!serverPromise) serverPromise = bootServer();
  return serverPromise;
}

async function bootServer() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcbot-it-"));
  const port = await pickFreePort();
  writeServerFiles(workDir, port);

  let child;
  try {
    // The Nix wrapper appends `nogui` after `-jar server.jar`; any argv we
    // pass would be forwarded to Java as JVM options, so leave it empty.
    child = spawn("minecraft-server", [], {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "minecraft-server not on PATH; run integration tests inside nix-shell",
      );
    }
    throw error;
  }

  const lines = attachLineReader(child.stdout);
  child.stderrTail = "";
  child.stderr.on("data", (chunk) => {
    child.stderrTail = (child.stderrTail + chunk.toString("utf8")).slice(-8192);
  });

  await waitForServerLine(
    child, lines, SERVER_READY_RE, SERVER_START_TIMEOUT_MS,
  );

  return {
    child,
    workDir,
    lines,
    port,
    sendCommand: (line) => sendCommand(child, line),
    barrier: (timeoutMs) => barrier(child, lines, timeoutMs),
  };
}

function writeServerFiles(workDir, port) {
  fs.writeFileSync(path.join(workDir, "eula.txt"), "eula=true\n");
  fs.writeFileSync(
    path.join(workDir, "server.properties"),
    renderServerProperties(port),
  );
  // Pre-op the bot user so /fill, /tp, /gamemode succeed on first join.
  fs.writeFileSync(
    path.join(workDir, "ops.json"),
    JSON.stringify([{
      uuid: offlineUuid(BOT_USERNAME),
      name: BOT_USERNAME,
      level: 4,
      bypassesPlayerLimit: false,
    }], null, 2) + "\n",
  );
}

function renderServerProperties(port) {
  // Custom flat preset: bedrock + 3 stone + 1 grass on plains. Peaceful with
  // no mobs/weather/nether so pathing tests are deterministic.
  const generator = JSON.stringify({
    layers: [
      { block: "minecraft:bedrock", height: 1 },
      { block: "minecraft:stone", height: 3 },
      { block: "minecraft:grass_block", height: 1 },
    ],
    biome: "minecraft:plains",
  });
  const props = {
    "level-type": "minecraft:flat",
    "generator-settings": generator,
    "online-mode": "false",
    "server-port": String(port),
    "spawn-protection": "0",
    "max-players": "4",
    "view-distance": "6",
    "simulation-distance": "6",
    "difficulty": "peaceful",
    "spawn-monsters": "false",
    "spawn-animals": "false",
    "spawn-npcs": "false",
    "allow-nether": "false",
    "pvp": "false",
    "enable-command-block": "false",
    "motd": "mcbot integration test",
    "level-name": "world",
    "level-seed": "mcbottest",
    "gamemode": "creative",
    "force-gamemode": "true",
    "op-permission-level": "4",
  };
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// Mojang's offline-mode UUID derivation: MD5("OfflinePlayer:<name>") with
// version=3 / RFC4122-variant bits set. Matches what the server records.
function offlineUuid(name) {
  const hash = crypto.createHash("md5")
    .update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Send one command line to the server console.
function sendCommand(child, line) {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${line}\n`, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

// Send a `say <token>` sentinel and resolve when its echo appears in stdout.
// Because the server processes console commands in order, this guarantees
// every command sent before `barrier()` has been executed.
async function barrier(child, lines, timeoutMs = BARRIER_TIMEOUT_MS) {
  const token = `__barrier_${crypto.randomBytes(8).toString("hex")}__`;
  const seen = waitForServerLine(
    child, lines, new RegExp(`\\[Server\\] ${token}\\b`), timeoutMs,
  );
  await sendCommand(child, `say ${token}`);
  await seen;
}

// Subscribe a per-line listener to a chunked stdout stream.
function attachLineReader(stream) {
  const listeners = new Set();
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const line of parts) {
      for (const listener of listeners) listener(line);
    }
  });
  return listeners;
}

// Resolve when a stdout line matches `re`. Rejects on timeout or early exit.
function waitForServerLine(child, listeners, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      listeners.delete(listener);
      child.removeListener("exit", onExit);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`timeout waiting for ${re}`)),
      timeoutMs,
    );
    const onExit = (code, signal) => finish(reject, new Error(
      `minecraft-server exited (code=${code}, signal=${signal}) `
        + `while waiting for ${re}\n${child.stderrTail || ""}`,
    ));
    const listener = (line) => {
      if (re.test(line)) finish(resolve, line);
    };
    listeners.add(listener);
    child.once("exit", onExit);
  });
}

async function stopServer(handle) {
  const { child, workDir } = handle;
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(
        () => child.kill("SIGKILL"), SERVER_STOP_TIMEOUT_MS,
      );
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { child.stdin.write("stop\n"); } catch { child.kill("SIGTERM"); }
    });
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Bot lifecycle
//
// `startBot(server)` launches a fresh `mcbot.js` connected to the shared
// integration server, on a random localhost port, and returns a handle that
// runs /eval requests and stops the subprocess on demand. Each test should
// own one bot and stop it before the next test starts.

const MCBOT_PATH = path.resolve(__dirname, "..", "..", "mcbot.js");
const BOT_START_TIMEOUT_MS = 60_000;
const BOT_STOP_TIMEOUT_MS = 5_000;

// Lines mcbot.js prints once it is ready to serve /eval requests.
const BOT_READY_LINES = [/\[bot\] spawned/, /\[http\] listening/];

async function startBot(server) {
  const httpPort = await pickFreePort();
  const child = spawn(process.execPath, [
    MCBOT_PATH,
    "--server", `127.0.0.1:${server.port}`,
    "--user", BOT_USERNAME,
    "--http", `127.0.0.1:${httpPort}`,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  try {
    await waitForBotLines(child, BOT_READY_LINES, BOT_START_TIMEOUT_MS);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    httpPort,
    eval: (code) => evalRequest(httpPort, code),
    stop: () => stopBot(child),
  };
}

// POST `code` to mcbot's /eval and return the response body. Throws an
// error tagged with status/body on non-200 responses (script failure,
// timeout, etc.).
function evalRequest(httpPort, code) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(code, "utf8");
    const req = http.request({
      host: "127.0.0.1",
      port: httpPort,
      path: "/eval",
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": data.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 200) {
          resolve(body);
          return;
        }
        const error = new Error(
          `eval ${res.statusCode}: ${body.slice(0, 500)}`,
        );
        error.status = res.statusCode;
        error.body = body;
        reject(error);
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

// Wait until every regex in `regexes` has matched a line on stdout or stderr.
function waitForBotLines(child, regexes, timeoutMs) {
  const remaining = new Set(regexes);
  let buffer = "";
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onData);
      child.removeListener("exit", onExit);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(
      `mcbot did not become ready within ${timeoutMs}ms; `
        + `still waiting for: ${[...remaining].map(String).join(", ")}`,
    )), timeoutMs);
    const onExit = (code, signal) => finish(reject, new Error(
      `mcbot exited before ready (code=${code}, signal=${signal})`,
    ));
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        for (const re of remaining) {
          if (re.test(line)) remaining.delete(re);
        }
      }
      if (remaining.size === 0) finish(resolve);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopBot(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), BOT_STOP_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

// Bind to port 0 to let the OS allocate a free port, then close.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------

module.exports = { withWorld };
