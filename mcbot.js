#!/usr/bin/env node

// Simple mineflayer bot that executes arbitrary JS received over HTTP.
//
// Usage:
//   node mcbot.js [options]
//
// Options:
//   --server <host:port>  Minecraft server address   (default: localhost:25565)
//   --user <name>         Bot username               (default: mcbot)
//   --http <host:port>    HTTP server bind address   (default: localhost:3000)
//   --timeout <ms>        Per-request deadline       (default: 120000)
//   -h, --help            Show this help
//
// POST any JS source to http://<http>/eval and it will be evaluated in an
// async function with `bot`, `goals`, `Vec3`, `print`, `sleep`,
// `withTimeout`, and `abort` (an AbortSignal) in scope. Anything the script
// passes to `print(...)` is
// collected and returned as the response body. The script's own return
// value is ignored.
//
// Each request is hermetic: behavior/intent state the script introduces
// (control states, pathfinder goals, pvp targets, listeners it adds,
// timers it schedules, open windows, activated items) is rolled back when
// the script settles, when the client disconnects, or when the deadline
// expires. Game/world state (position, health, inventory, broken/placed
// blocks) is never touched.
//
// GET http://<http>/listen streams Minecraft chat messages as newline-delimited
// JSON using chunked transfer encoding.

const http = require("http");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { loader: autoEat } = require("mineflayer-auto-eat");
const { plugin: pvp } = require("mineflayer-pvp");
const hawkEye = require("minecrafthawkeye").default;
const Vec3 = require("vec3").Vec3;
const util = require("util");

const ARG_OPTIONS = {
  server: { type: "string", default: "localhost:25565" },
  user: { type: "string", default: "mcbot" },
  http: { type: "string", default: "localhost:3000" },
  timeout: { type: "string", default: "120000" },
  help: { type: "boolean", short: "h", default: false },
};

const HELP = `Usage: node mcbot.js [options]

Options:
  --server <host:port>  Minecraft server address   (default: localhost:25565)
  --user <name>         Bot username               (default: mcbot)
  --http <host:port>    HTTP server bind address   (default: localhost:3000)
  --timeout <ms>        Per-request deadline       (default: 120000)
  -h, --help            Show this help
`;

// ---------------------------------------------------------------------------
// Entry point

function main() {
  let values;
  try {
    ({ values } = util.parseArgs({
      args: process.argv.slice(2),
      options: ARG_OPTIONS,
      strict: true,
    }));
  } catch (err) {
    console.error(err.message);
    console.error(HELP);
    process.exit(2);
  }

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const [mcHost, mcPort] = parseHostPort(values.server);
  const [httpHost, httpPort] = parseHostPort(values.http);
  const defaultTimeoutMs = parseInt(values.timeout, 10);
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    console.error(`invalid --timeout: ${values.timeout}`);
    process.exit(2);
  }

  const config = {
    mcHost,
    mcPort,
    mcUsername: values.user,
    httpHost,
    httpPort,
    defaultTimeoutMs,
  };

  const bot = createBot(config);
  const server = createServer(bot, config);
  server.listen(config.httpPort, config.httpHost, () => {
    console.log(
      `[http] listening on http://${config.httpHost}:${config.httpPort} `
        + `(/eval, /listen)`,
    );
  });
}

function parseHostPort(s) {
  const idx = s.lastIndexOf(":");
  if (idx < 0) throw new Error(`expected host:port, got "${s}"`);
  const host = s.slice(0, idx);
  const port = parseInt(s.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`invalid host:port "${s}"`);
  }
  return [host, port];
}

function createBot(config) {
  const bot = mineflayer.createBot({
    host: config.mcHost,
    port: config.mcPort,
    username: config.mcUsername,
    auth: "offline",
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(pvp);
  bot.loadPlugin(hawkEye);

  // Scripts may transiently register many listeners per request. The wrapper
  // removes them on cleanup, so the default limit of 10 is just noise.
  bot.setMaxListeners(200);

  bot.once("spawn", () => {
    bot.pathfinder.setMovements(new Movements(bot));
  });

  bot.on("login", () => console.log(`[bot] logged in as ${bot.username}`));
  bot.on("spawn", () => console.log("[bot] spawned"));
  bot.on("kicked", (reason) => console.log(`[bot] kicked: ${reason}`));
  bot.on("error", (err) => console.log(`[bot] error: ${err.message}`));
  bot.on("end", (reason) => {
    console.log(`[bot] disconnected: ${reason}`);
    process.exit(0);
  });

  return bot;
}

// ---------------------------------------------------------------------------
// HTTP server

function createServer(bot, config) {
  // Serialize /eval requests: instance-level method patches cannot safely
  // interleave. One bot, one request at a time.
  const queue = createMutex();
  const chatBroadcaster = createChatBroadcaster(bot);

  return http.createServer(async (req, res) => {
    const url = req.url ? new URL(req.url, "http://localhost") : null;
    const pathname = url ? url.pathname : req.url;

    if (req.method === "GET" && pathname === "/listen") {
      handleListen(chatBroadcaster, req, res);
      return;
    }

    if (req.method !== "POST" || pathname !== "/eval") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("POST JS to /eval or GET /listen\n");
      return;
    }

    let code;
    try {
      code = await readBody(req);
    } catch (err) {
      writeIfOpen(res, 400, "text/plain", `read error: ${err.message}\n`);
      return;
    }

    await queue(() => handleEval(bot, config, req, res, code));
  });
}

function createChatBroadcaster(bot) {
  const clients = new Set();
  bot.on("chat", (username, message, translate, jsonMsg, matches) => {
    if (username === bot.username) return;

    const event = {
      type: "chat",
      username,
      message,
      timestamp: new Date().toISOString(),
    };
    if (translate !== undefined) event.translate = translate;
    if (matches !== undefined) event.matches = matches;
    if (jsonMsg !== undefined && jsonMsg !== null) {
      event.json = typeof jsonMsg.toString === "function"
        ? jsonMsg.toString()
        : jsonMsg;
    }
    broadcastJsonLine(clients, event);
  });
  return clients;
}

function handleListen(clients, _req, res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcastJsonLine(clients, event) {
  const line = JSON.stringify(event) + "\n";
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    client.write(line);
  }
}

async function handleEval(bot, config, req, res, code) {
  const controller = new AbortController();
  const { signal } = controller;
  const output = [];
  const print = (...args) => { output.push(util.format(...args)); };

  // Abort on premature client disconnect. Listen on `res` (not `req`):
  // req's 'close' isn't reliably emitted once the body has been drained;
  // res emits 'close' when the underlying socket dies regardless.
  const onClose = () => {
    if (!res.writableEnded && !signal.aborted) {
      controller.abort(makeAbortReason("client-disconnect"));
    }
  };
  res.on("close", onClose);

  // Hard per-request deadline.
  const deadline = setTimeout(() => {
    if (!signal.aborted) controller.abort(makeAbortReason("deadline"));
  }, config.defaultTimeoutMs);

  // Track promises returned by patched awaitable wrappers so we can
  // attach terminal catches on fire-and-forget calls once the request ends.
  // Without this, a script that does `bot.dig(x)` without `await` would
  // produce an unhandled rejection when abort fires.
  const pendingPromises = new Set();

  const scope = installPatches(bot, signal, pendingPromises);

  let scriptError = null;
  try {
    await raceAbort(signal,
      runCode(bot, goals, Vec3, print, signal, scope.timers, code),
      null);
  } catch (err) {
    scriptError = err;
  } finally {
    clearTimeout(deadline);
    res.off("close", onClose);

    // Make sure abort has fired before cleanups run, so any still-pending
    // awaited calls inside the script see AbortError rather than blocking.
    if (!signal.aborted) controller.abort(makeAbortReason("script-end"));

    // LIFO cleanup. Errors are collected, never thrown.
    const cleanupErrors = await scope.runCleanups();

    // Attach terminal catches to any patched-awaitable promises the script
    // didn't await. They may reject with AbortError; that's expected.
    for (const p of pendingPromises) {
      p.catch(() => {});
    }
    pendingPromises.clear();

    // Restore method patches. We do this after cleanup so the zombie tail
    // of the script (if any) still hits wrapped methods; but we don't wait
    // for it — a bounded grace period bounds how long patches stay live.
    scope.restore();

    // Respond, if the client is still listening.
    const reason = signal.aborted ? abortReasonTag(signal.reason) : null;
    if (reason === "client-disconnect") {
      // Nobody to tell. Log outcome for server operator.
      if (scriptError) {
        console.log(`[eval] client gone, script error: ${scriptError.message}`);
      }
      return;
    }

    if (scriptError && !isAbortError(scriptError)) {
      writeIfOpen(res, 500, "application/json",
        JSON.stringify({
          error: scriptError.message,
          stack: scriptError.stack,
          output: output.join("\n"),
          cleanupErrors: cleanupErrors.map((e) => e.message),
        }) + "\n");
      return;
    }

    if (reason === "deadline") {
      writeIfOpen(res, 504, "application/json",
        JSON.stringify({
          error: "deadline exceeded",
          output: output.join("\n"),
          cleanupErrors: cleanupErrors.map((e) => e.message),
        }) + "\n");
      return;
    }

    writeIfOpen(res, 200, "text/plain",
      output.join("\n") + (output.length ? "\n" : ""));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeIfOpen(res, status, contentType, body) {
  if (res.writableEnded) return;
  try {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  } catch { /* socket gone */ }
}

async function runCode(bot, goals, Vec3, print, abort, timers, code) {
  const sleep = createSleep(timers, abort);
  const withTimeout = createWithTimeout(timers, abort);
  const blockedTimers = createBlockedTimers();
  const body = `return (async () => { ${code} })();`;
  const fn = new Function(
    "bot", "goals", "Vec3", "print", "sleep", "withTimeout", "abort",
    "setTimeout", "clearTimeout",
    "setInterval", "clearInterval",
    "setImmediate", "clearImmediate",
    body,
  );
  await fn(
    bot, goals, Vec3, print, sleep, withTimeout, abort,
    blockedTimers.setTimeout, blockedTimers.clearTimeout,
    blockedTimers.setInterval, blockedTimers.clearInterval,
    blockedTimers.setImmediate, blockedTimers.clearImmediate,
  );
}

function createSleep(timers, abort) {
  return (ms, value) => {
    const delay = createAbortableDelay(timers, abort, ms);
    return delay.promise.then(() => value);
  };
}

function createWithTimeout(timers, abort) {
  return function withTimeout(ms, promise) {
    if (arguments.length < 2) {
      throw new TypeError("withTimeout(ms, promise) requires a promise");
    }

    const delay = createAbortableDelay(timers, abort, ms);
    return Promise.race([
      Promise.resolve(promise),
      delay.promise.then(() => { throw makeTimeoutReason(delay.ms); }),
    ]).finally(delay.cancel);
  };
}

function createAbortableDelay(timers, abort, ms) {
  const delay = normalizeDelay(ms);
  let settled = false;
  let handle = null;
  let onAbort = null;

  const cleanup = () => {
    if (handle !== null) timers.clearTimeout(handle);
    if (onAbort !== null) abort.removeEventListener("abort", onAbort);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };

  const promise = new Promise((resolve, reject) => {
    if (abort.aborted) return reject(abort.reason);

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    onAbort = () => settle(reject, abort.reason);

    abort.addEventListener("abort", onAbort, { once: true });
    handle = timers.setTimeout(() => settle(resolve), delay);
  });

  return { ms: delay, promise, cancel };
}

function createBlockedTimers() {
  const block = (name) => () => {
    throw new Error(
      `${name} is disabled in /eval; use sleep(ms) or withTimeout(ms, promise)`,
    );
  };
  return {
    setTimeout: block("setTimeout"),
    clearTimeout: block("clearTimeout"),
    setInterval: block("setInterval"),
    clearInterval: block("clearInterval"),
    setImmediate: block("setImmediate"),
    clearImmediate: block("clearImmediate"),
  };
}

function normalizeDelay(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new TypeError(`invalid delay: ${ms}`);
  }
  return delay;
}

function makeTimeoutReason(ms) {
  const err = new Error(`timeout after ${ms}ms`);
  err.name = "TimeoutError";
  err.code = "ETIMEDOUT";
  return err;
}

// ---------------------------------------------------------------------------
// Mutex — serialize requests so patches don't interleave.

function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    // Swallow errors on the chain so a failed task doesn't poison the queue.
    tail = run.catch(() => {});
    return run;
  };
}

// ---------------------------------------------------------------------------
// Abort helpers

function makeAbortReason(tag) {
  const err = new Error(`aborted: ${tag}`);
  err.name = "AbortError";
  err.reason = tag;
  return err;
}

function abortReasonTag(reason) {
  if (reason && typeof reason === "object" && "reason" in reason) {
    return reason.reason;
  }
  return "abort";
}

function isAbortError(err) {
  return err && (err.name === "AbortError" || err.code === "ABORT_ERR");
}

// Rejects when `signal` aborts. Never resolves.
function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Race a real promise against the signal. Exactly one settle.
// If abort wins, call `onAbort()` (native cancel) and reject with the reason.
// If the real promise wins, return its value; the settlement from the signal
// is never delivered.
function raceAbort(signal, realPromise, onAbort) {
  if (signal.aborted) {
    try { onAbort && onAbort(); } catch { /* ignore */ }
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      try { onAbort && onAbort(); } catch { /* ignore */ }
      reject(signal.reason);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    realPromise.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Patch installer
//
// We wrap a known list of mutating verbs on the bot and its plugins. Each
// wrapper:
//   - registers a compensating undo on the per-request cleanup stack
//     (with a dedup key so repeated calls only schedule one undo);
//   - for awaitable ops, races against `signal` and invokes native cancel
//     when abort wins;
//   - rejects pre-aborted calls without touching the underlying op.
//
// Non-enumerable: patches apply to the *instance*, saved originals restore
// in finally. We also patch bot.on/once/addListener to auto-remove script
// listeners. Raw timer globals in the script scope are blocked; sleep(...) and
// withTimeout(...) use tracked request-scoped timers that cleanup clears below.

function installPatches(bot, signal, pending) {
  // Wrap a patched-awaitable's return promise so we can track it for
  // terminal-catch attachment at end-of-request. The returned promise is
  // what the script sees; if it awaits, tracking is harmless; if not, the
  // request lifecycle will attach a .catch(() => {}) to it.
  const track = (p) => { pending.add(p); return p; };

  const cleanups = []; // { key, fn, done }
  const seen = new Set();
  const originals = []; // { target, key, value }

  function save(target, key) {
    originals.push({ target, key, value: target[key] });
  }

  function patch(target, key, wrapper) {
    if (!target || typeof target[key] !== "function") return;
    save(target, key);
    target[key] = wrapper(target[key].bind(target));
  }

  function addCleanup(key, fn) {
    if (seen.has(key)) return;
    seen.add(key);
    cleanups.push({ key, fn, done: false });
  }

  // Mark a cleanup as already discharged (e.g. awaitable wrapper invoked
  // native cancel on abort; we don't want end-of-request to redo it).
  function discharge(key) {
    for (const c of cleanups) {
      if (c.key === key) c.done = true;
    }
  }

  // Patch an awaitable method. It races against `signal` and rejects with
  // AbortError on abort; fire-and-forget returns are still tracked so their
  // rejections don't leak.
  function patchAwaitable(target, key) {
    patch(target, key, (orig) => (...args) =>
      track(raceAbort(signal, orig(...args), null)));
  }

  // Patch an awaitable method that also latches behavior (goal, dig state).
  // Registers a cleanup under `cleanupKey` that invokes `cancel`; on abort,
  // `cancel` runs immediately and the cleanup entry is marked discharged.
  function patchCancelable(target, key, cleanupKey, cancel) {
    patch(target, key, (orig) => (...args) => {
      addCleanup(cleanupKey, cancel);
      return track(raceAbort(signal, orig(...args),
        () => { cancel(); discharge(cleanupKey); }));
    });
  }

  // --- bot.setControlState ---------------------------------------------------
  // Sync mutator. Undo: zero the key on cleanup.
  patch(bot, "setControlState", (orig) => (state, value) => {
    if (value) addCleanup(`control:${state}`, () => orig(state, false));
    return orig(state, value);
  });

  // --- bot.on / once / addListener -------------------------------------------
  // Track listeners added during the request; remove on cleanup. We use a
  // single aggregate cleanup entry to avoid hundreds of per-listener entries.
  const addedListeners = []; // { event, fn }
  const trackListener = (event, fn) => {
    addedListeners.push({ event, fn });
  };
  addCleanup("listeners", () => {
    const errors = [];
    for (const { event, fn } of addedListeners) {
      try { bot.removeListener(event, fn); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw errors[0];
  });

  patch(bot, "on", (orig) => (event, fn) => {
    trackListener(event, fn);
    return orig(event, fn);
  });
  patch(bot, "addListener", (orig) => (event, fn) => {
    trackListener(event, fn);
    return orig(event, fn);
  });
  patch(bot, "once", (orig) => (event, fn) => {
    // once() auto-removes on fire, but we still track it so an unfired
    // listener gets removed on cleanup.
    trackListener(event, fn);
    return orig(event, fn);
  });

  // --- Awaitables without native cancel --------------------------------------
  // On abort, the script's await rejects; the underlying op runs to natural
  // completion. Acceptable since the bot's latched state is handled elsewhere.
  for (const key of [
    "equip", "unequip", "toss", "tossStack", "consume",
    "craft", "placeBlock", "activateBlock", "lookAt",
  ]) {
    patchAwaitable(bot, key);
  }

  // --- Awaitables with native cancel -----------------------------------------
  patchCancelable(bot, "dig", "dig",
    () => { if (bot.stopDigging) bot.stopDigging(); });

  const pf = bot.pathfinder;
  patchCancelable(pf, "goto", "pathfinder:goal",
    () => { if (pf && pf.setGoal) pf.setGoal(null); });

  // --- bot.activateItem ------------------------------------------------------
  // Sync call, but "activated" state latches; undo by calling deactivateItem.
  patch(bot, "activateItem", (orig) => (...args) => {
    addCleanup("activateItem", () => {
      if (bot.deactivateItem) bot.deactivateItem();
    });
    return orig(...args);
  });

  // --- bot.openContainer / openChest -----------------------------------------
  // The cleanup key depends on the resolved window id, so this doesn't fit
  // patchAwaitable/patchCancelable cleanly.
  for (const name of ["openContainer", "openChest"]) {
    patch(bot, name, (orig) => (...args) => {
      const p = orig(...args).then((window) => {
        if (window) {
          addCleanup(`window:${window.id ?? name}`, () => {
            if (bot.currentWindow === window) bot.closeWindow(window);
          });
        }
        return window;
      });
      return track(raceAbort(signal, p, null));
    });
  }

  // --- bot.pathfinder.setGoal ------------------------------------------------
  // Sync. If the script sets a goal directly (not via goto), still undo.
  // (pf.setMovements: policy knob, not latching behavior; leave unpatched.)
  patch(pf, "setGoal", (orig) => (goal, dynamic) => {
    if (goal !== null && goal !== undefined) {
      addCleanup("pathfinder:goal", () => orig(null));
    }
    return orig(goal, dynamic);
  });

  // --- bot.pvp ---------------------------------------------------------------
  patch(bot.pvp, "attack", (orig) => (...args) => {
    addCleanup("pvp", () => { if (bot.pvp && bot.pvp.stop) bot.pvp.stop(); });
    return orig(...args);
  });

  // --- bot.chat / whisper ----------------------------------------------------
  // No latching; leave unpatched. Chat messages are already committed when
  // the method returns; there's nothing to undo.

  // --- Timers ---------------------------------------------------------------
  // We don't touch Node globals (that would affect the whole process). Instead,
  // sleep(...) and withTimeout(...) use this per-request scope. runCode shadows
  // raw timer globals with throwers so scripts cannot create background timers.
  // Outstanding internal handles are cleared on cleanup.
  const timers = createTimerScope();
  addCleanup("timers", timers.clearAll);

  function restore() {
    for (const { target, key, value } of originals) {
      target[key] = value;
    }
  }

  async function runCleanups() {
    const errors = [];
    // LIFO.
    for (let i = cleanups.length - 1; i >= 0; i--) {
      const entry = cleanups[i];
      if (entry.done) continue;
      entry.done = true;
      try {
        await entry.fn();
      } catch (err) {
        errors.push(err);
      }
    }
    return errors;
  }

  return { runCleanups, restore, timers };
}

// Per-request timeout scope for sleep(...) and withTimeout(...). Returns
// tracking variants of setTimeout/clearTimeout plus a `clearAll` that fires on
// cleanup.
function createTimerScope() {
  const timeouts = new Set();

  return {
    setTimeout: (fn, ms, ...args) => {
      const h = setTimeout((...a) => {
        timeouts.delete(h);
        fn(...a);
      }, ms, ...args);
      timeouts.add(h);
      return h;
    },
    clearTimeout: (h) => { timeouts.delete(h); return clearTimeout(h); },
    clearAll: () => {
      for (const h of timeouts) clearTimeout(h);
      timeouts.clear();
    },
  };
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  main();
}

module.exports = {
  parseHostPort,
  createBot,
  createServer,
  createChatBroadcaster,
  handleListen,
  broadcastJsonLine,
  handleEval,
  readBody,
  writeIfOpen,
  runCode,
  createSleep,
  createWithTimeout,
  createAbortableDelay,
  createBlockedTimers,
  normalizeDelay,
  makeTimeoutReason,
  createMutex,
  makeAbortReason,
  abortReasonTag,
  isAbortError,
  abortPromise,
  raceAbort,
  installPatches,
  createTimerScope,
};
