#!/usr/bin/env node

// Simple mineflayer bot that executes arbitrary JS received over HTTP.
//
// Usage:
//   node mcbot.js [options]
//
// Run with --help to print generated command-line usage.
//
// POST any JS source to http://<http>/eval and it will be evaluated in an
// async function with `bot`, `snippets`, `Vec3`, `print`, `sleep`,
// `withTimeout`, and `abort` (an AbortSignal) in scope. The timer globals
// (`setTimeout`, `setInterval`, `setImmediate` and their clear counterparts)
// are replaced by versions that throw; scripts use `sleep`/`withTimeout`
// instead. `bot` is a curated
// per-request facade over the mineflayer bot (see createBotFacade); the
// underlying mineflayer bot is shared across requests and never mutated.
// Before each eval, exports from .pi/minecraft/snippets.js in the current
// working directory are reloaded and passed as `snippets`. Anything the script
// passes to `print(...)` is collected and returned as the response body. The
// script's own return value is ignored.
//
// Eval requests are serialized: one bot control script runs at a time.
//
// Each request is hermetic: behavior/intent state the script introduces
// (control states, listeners it adds, timers it schedules, open windows,
// activated items, in-flight long-running bot calls) is rolled back when the
// script settles, when the client disconnects, or when the deadline expires.
// Game/world state (position, health, inventory, broken/placed blocks) is
// never touched.
//
// GET http://<http>/listen streams Minecraft chat messages as
// newline-delimited JSON using chunked transfer encoding.
//
// Keep the HTTP listener bound to localhost unless every client on the network
// is trusted; /eval intentionally executes arbitrary JavaScript.

const http = require("http");
const path = require("path");
const mineflayer = require("mineflayer");
const Vec3 = require("vec3").Vec3;
const pathfinder = require("./pathfinder.js");
const util = require("util");

// ---------------------------------------------------------------------------
// Main / CLI

// Command-line options: name -> [description, default value].
const CLI_OPTIONS = {
  server: ["Minecraft server address", "localhost:25565"],
  user: ["Bot username", "mcbot"],
  http: ["HTTP server bind address", "localhost:3000"],
  timeout: ["Per-request deadline in milliseconds", "120000"],
};

const USAGE = formatUsage();

// Start the bot runtime from command-line arguments.
function main() {
  let config;
  try {
    config = parseConfig(process.argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  const bot = createMinecraftBot(config);
  const server = createServer(bot, config);

  server.listen(config.http.port, config.http.host, () => {
    console.log(
      `[http] listening on http://${config.http.host}:${config.http.port} `
        + `(/eval, /listen)`,
    );
  });
}

// Convert raw process arguments into normalized runtime configuration.
function parseConfig(argv) {
  const args = parseArgs(argv);

  return {
    minecraft: parseHostPort(args.server),
    username: args.user,
    http: parseHostPort(args.http),
    requestTimeoutMs: parsePositiveInteger(args.timeout, "--timeout"),
  };
}

// Parse `--name value` and `--name=value` options into a name -> string map.
// Malformed input throws; `--help` prints usage and exits.
function parseArgs(argv) {
  const values = Object.fromEntries(
    Object.entries(CLI_OPTIONS).map(([name, [, fallback]]) => [name, fallback]),
  );
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--help") {
      console.log(USAGE);
      process.exit(0);
    }

    const eq = token.indexOf("=");
    const name = token.startsWith("--")
      ? token.slice(2, eq < 0 ? undefined : eq)
      : "";
    if (!Object.hasOwn(CLI_OPTIONS, name)) {
      throw new Error(`unknown argument "${token}"`);
    }

    const value = eq >= 0 ? token.slice(eq + 1) : args[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) {
      throw new Error(`missing value for --${name}`);
    }

    values[name] = value;
  }

  return values;
}

// Build the command-line usage text from CLI_OPTIONS.
function formatUsage() {
  const rows = [
    ...Object.entries(CLI_OPTIONS).map(([name, [description, fallback]]) =>
      [`--${name} <value>`, `${description} (default: ${fallback})`]),
    ["--help", "Show this help"],
  ];

  const width = Math.max(...rows.map(([option]) => option.length));
  const options = rows
    .map(([option, description]) => `  ${option.padEnd(width)}  ${description}`)
    .join("\n");

  return `Usage: node mcbot.js [options]\n\nOptions:\n${options}\n`;
}

// Split a host:port string into a host and a numeric port.
function parseHostPort(value) {
  const idx = value.lastIndexOf(":");
  if (idx < 0) throw new Error(`expected host:port, got "${value}"`);

  const host = value.slice(0, idx);
  const port = parseInt(value.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`invalid host:port "${value}"`);
  }
  return { host, port };
}

// Parse and validate a positive integer command-line value.
function parsePositiveInteger(value, label) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Bot runtime

// Create and initialize the Mineflayer bot instance.
function createMinecraftBot(config) {
  const bot = mineflayer.createBot({
    host: config.minecraft.host,
    port: config.minecraft.port,
    username: config.username,
    auth: "offline",
  });

  // Eval scripts may temporarily install many listeners. They are removed by
  // request cleanup, so the EventEmitter default of 10 only creates noise.
  bot.setMaxListeners(200);

  installBotLifecycleHandlers(bot);
  return bot;
}

// Log bot lifecycle events and end the process when the connection drops.
function installBotLifecycleHandlers(bot) {
  bot.on("login", () => console.log(`[bot] logged in as ${bot.username}`));
  bot.on("spawn", () => console.log("[bot] spawned"));
  bot.on("kicked", (reason) => console.log(`[bot] kicked: ${reason}`));
  bot.on("error", (error) => console.log(`[bot] error: ${error.message}`));
  bot.on("end", (reason) => {
    console.log(`[bot] disconnected: ${reason}`);
    // No reconnect policy: the supervising process restarts the runtime.
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// HTTP server

// Create the HTTP control server around an existing bot. The runtime holds the
// long-lived state shared by every request; the router protects it from
// uncaught errors.
function createServer(bot, config) {
  const runtime = {
    bot,
    config,
    evalQueue: createSerialQueue(),
    chat: createChatBroadcaster(bot),
  };

  return http.createServer((req, res) => {
    routeRequest(runtime, req, res).catch((error) => {
      writeResponse(
        res,
        500,
        "text/plain",
        `internal error: ${error.message}\n`,
      );
    });
  });
}

// Dispatch HTTP requests to /eval, /listen, or the 404 response.
async function routeRequest(runtime, req, res) {
  const pathname = getPathname(req);

  if (req.method === "GET" && pathname === "/listen") {
    runtime.chat.addClient(res);
    return;
  }

  if (req.method === "POST" && pathname === "/eval") {
    await handleEvalRequest(runtime, req, res);
    return;
  }

  writeResponse(res, 404, "text/plain", "POST JS to /eval or GET /listen\n");
}

// Extract a request pathname without depending on an external host.
function getPathname(req) {
  if (!req.url) return "";
  return new URL(req.url, "http://localhost").pathname;
}

// Read an eval body and enqueue it for serialized execution.
async function handleEvalRequest(runtime, req, res) {
  let code;
  try {
    code = await readBody(req);
  } catch (error) {
    writeResponse(res, 400, "text/plain", `read error: ${error.message}\n`);
    return;
  }

  await runtime.evalQueue(() => runEvalSession(runtime, res, code));
}

// ---------------------------------------------------------------------------
// Eval session

// Run one complete /eval request lifecycle.
async function runEvalSession(runtime, res, code) {
  const session = createEvalSession(runtime, res);
  let scriptError = null;
  let cleanupErrors;

  try {
    await raceAbort(
      session.deadline.signal,
      executeUserCode(buildEvalBindings(session), code),
    );
  } catch (error) {
    scriptError = error;
  } finally {
    cleanupErrors = await finishEvalSession(session);
  }

  writeEvalResult(session, scriptError, cleanupErrors);
}

// Create all request-scoped state used by an eval session.
function createEvalSession(runtime, res) {
  const deadline = createDeadline(runtime.config.requestTimeoutMs);

  const onClose = () => {
    if (!res.writableEnded) deadline.abort("client-disconnect");
  };
  // Listen on res, not req: after the body is drained, req.close is not a
  // reliable client-disconnect signal, but res.close still follows the socket.
  res.on("close", onClose);

  const cleanup = createCleanupStack();
  const timers = createTimerScope();
  cleanup.deferOnce("timers", timers.clearAll);

  return {
    bot: runtime.bot,
    config: runtime.config,
    res,
    deadline,
    onClose,
    output: [],
    cleanup,
    timers,
    pendingPromises: new Set(),
  };
}

// Create the request deadline: the signal request work races against, the way
// to trip it with a machine-readable reason, and the per-request timer.
function createDeadline(timeoutMs) {
  const controller = new AbortController();
  const { signal } = controller;

  const abort = (reason) => {
    if (!signal.aborted) controller.abort(makeAbortError(reason));
  };

  const timeoutId = setTimeout(() => abort("deadline"), timeoutMs);
  if (typeof timeoutId.unref === "function") timeoutId.unref();

  return { signal, abort, stopTimer: () => clearTimeout(timeoutId) };
}

// Build the bindings user code sees as its scope. Their names are the /eval
// API surface; executeUserCode derives both parameters and arguments from
// this one object, so the list is written down once.
function buildEvalBindings(session) {
  return {
    bot: createBotFacade(session.bot, session),
    snippets: loadSnippets(getSnippetsPath(session.config)),
    Vec3,
    print: (...args) => session.output.push(util.format(...args)),
    sleep: createSleep(session),
    withTimeout: createWithTimeout(session),
    abort: session.deadline.signal,
    ...createDisabledTimers(),
  };
}

// Execute user JavaScript in an async wrapper with the bindings as scope.
async function executeUserCode(bindings, code) {
  // Return values are deliberately ignored; print(...) is the only output
  // channel. Timer names are parameters so eval code sees the disabled
  // versions instead of Node's process-wide timer globals.
  const body = `return (async () => { ${code} })();`;
  const fn = new Function(...Object.keys(bindings), body);

  await fn(...Object.values(bindings));
}

// Abort outstanding request work and run cleanup.
async function finishEvalSession(session) {
  session.deadline.stopTimer();
  session.res.off("close", session.onClose);

  // Force request-scoped awaitables and helpers to observe completion before
  // cleanup runs. On a normal success/error this reason is intentionally
  // "script-end" and is not reported to the client.
  session.deadline.abort("script-end");

  const cleanupErrors = await session.cleanup.run();

  // Late rejections are already silenced by trackPromise; dropping the
  // references keeps fire-and-forget promises from outliving the request.
  session.pendingPromises.clear();

  return cleanupErrors;
}

// Translate session outcome into the final HTTP response.
function writeEvalResult(session, scriptError, cleanupErrors) {
  const { signal } = session.deadline;
  const reason = abortReasonTag(signal.reason);

  if (reason === "client-disconnect") {
    if (scriptError) {
      console.log(`[eval] client gone, script error: ${scriptError.message}`);
    }
    return;
  }

  const output = session.output.join("\n");
  const cleanupMessages = cleanupErrors.map((error) => error.message);

  // Only this request's own abort is expected here; an AbortError the script
  // raised itself is a real script failure and is reported as one.
  if (scriptError && scriptError !== signal.reason) {
    writeJson(session.res, 500, {
      error: scriptError.message,
      stack: scriptError.stack,
      output,
      cleanupErrors: cleanupMessages,
    });
    return;
  }

  if (reason === "deadline") {
    const timeoutMs = session.config.requestTimeoutMs;
    const hint = [
      `Your /eval script ran longer than this server's ${timeoutMs}ms`,
      "per-request deadline and was aborted. This is a server-imposed cap,",
      "not a bug in your script. To work within it: split long-running work",
      "across multiple /eval calls, bound individual awaits with",
      "withTimeout(ms, promise), and make sure loops have an exit condition.",
      "The operator can raise the limit via the server's --timeout flag.",
    ].join(" ");
    writeJson(session.res, 504, {
      error: "deadline exceeded",
      timeoutMs,
      hint,
      output,
      cleanupErrors: cleanupMessages,
    });
    return;
  }

  writeResponse(
    session.res,
    200,
    "text/plain",
    output + (session.output.length ? "\n" : ""),
  );
}

// Resolve the user snippets path. `config.snippetsPath` overrides the default
// location and may be relative to the current working directory.
function getSnippetsPath(config) {
  const snippetsPath = config.snippetsPath
    || path.join(process.cwd(), ".pi", "minecraft", "snippets.js");
  return path.isAbsolute(snippetsPath)
    ? snippetsPath
    : path.resolve(process.cwd(), snippetsPath);
}

// Load all CommonJS exports from snippets.js, returning an empty object when
// the optional file does not exist. Syntax/runtime errors in an existing file
// are surfaced to the eval caller.
function loadSnippets(snippetsPath) {
  let resolved;
  try {
    resolved = require.resolve(snippetsPath);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") return {};
    throw error;
  }

  delete require.cache[resolved];
  const loaded = require(resolved);
  if (loaded === null || loaded === undefined) return {};
  if (typeof loaded !== "object" && typeof loaded !== "function") {
    throw new TypeError(`${snippetsPath} must export an object or function`);
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Bot facade
//
// The `bot` value exposed to /eval scripts is built per-request by
// createBotFacade. The underlying mineflayer bot is shared across requests and
// is never patched; the facade is the entire eval-visible API surface.
// Whatever it does not expose is unreachable from eval code, so this list is
// the contract advertised in system.md.
//
// The facade enforces three per-request guarantees:
//   - Methods reject (or throw) once the request has aborted, so detached
//     continuations cannot mutate the bot after the script settles.
//   - Behavior/intent the script introduces (control states, listeners it
//     adds, opened windows, in-flight goto/follow, activated items, ongoing
//     dig) is undone via the request's cleanup stack.
//   - Long-running awaitables race against the abort signal so callers observe
//     AbortError instead of hanging.
//
// Read-only state is passed through directly: the script sees the same objects
// mineflayer already exposes (entity, inventory, world, registry, etc.).
// Returned helpers like Window are also passed through; their lifecycle is
// managed by the cleanup hook the facade installs.

// Build the per-request facade exposed to eval scripts as `bot`.
function createBotFacade(bot, session) {
  const { signal } = session.deadline;
  const { cleanup } = session;
  const trackedListeners = [];

  cleanup.deferOnce("listeners", () => {
    for (const { event, listener } of trackedListeners) {
      bot.removeListener(event, listener);
    }
  });

  // Throw if the request has already aborted; used by sync facade methods
  // and as the entry guard for awaitables.
  const guard = () => signal.throwIfAborted();

  // Run an underlying bot awaitable raced against the abort signal, with
  // late library-internal rejections suppressed.
  const racedAwait = (start, onAbort = null) => {
    guard();
    const promise = callPromise(start);
    suppressOriginalPromise(promise);
    return trackPromise(session, raceAbort(signal, promise, onAbort));
  };

  // Wrap a plain bot method as an abort-aware awaitable.
  const awaitable = (method) => (...args) =>
    racedAwait(() => bot[method](...args));

  const trackListener = (event, listener) => {
    trackedListeners.push({ event, listener });
  };

  // Open a bot window and auto-close it on cleanup if it's still current.
  // `target` is a block (containers/furnace/anvil/enchant) or entity (villager).
  const openWindow = (method) => (target) =>
    racedAwait(() => Promise.resolve(bot[method](target)).then((window) => {
      if (window) {
        cleanup.deferOnce(`window:${window.id}`, () => {
          if (bot.currentWindow === window) bot.closeWindow(window);
        });
      }
      return window;
    }));

  // Bespoke members keep their cleanup contracts or special wiring inline;
  // trivial pass-throughs are populated from the lists below.
  const facade = {
    // Disabling a control is allowed after abort so late continuations and
    // cleanup can always stop movement; only enabling one is guarded.
    setControlState(state, value) {
      if (value) {
        guard();
        cleanup.deferOnce(
          `control:${state}`,
          () => bot.setControlState(state, false),
        );
      }
      return bot.setControlState(state, value);
    },
    dig(block) {
      // Native cancellation runs on abort and again from cleanup; stopping is
      // idempotent so the second call is a no-op.
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (bot.stopDigging) bot.stopDigging();
      };
      cleanup.deferOnce("dig", stop);
      return racedAwait(() => bot.dig(block), stop);
    },
    activateItem(...args) {
      guard();
      cleanup.deferOnce("activateItem", () => {
        if (bot.deactivateItem) bot.deactivateItem();
      });
      return bot.activateItem(...args);
    },
    goto(goal, options) {
      return racedAwait(() => pathfinder.goto(facade, goal, options || {}));
    },
    follow(target, options) {
      return racedAwait(() => pathfinder.follow(facade, target, options || {}));
    },

    // Window-openers auto-close on cleanup (see openWindow).
    openContainer: openWindow("openContainer"),
    openFurnace: openWindow("openFurnace"),
    openAnvil: openWindow("openAnvil"),
    openEnchantmentTable: openWindow("openEnchantmentTable"),
    openVillager: openWindow("openVillager"),

    // Listener registration is request-tracked; cleanup removes anything
    // still attached when the request ends.
    on(event, listener) {
      guard();
      trackListener(event, listener);
      return bot.on(event, listener);
    },
    once(event, listener) {
      guard();
      // once() needs explicit tracking too: if it never fires, EventEmitter
      // will not remove it for us before the request ends.
      trackListener(event, listener);
      return bot.once(event, listener);
    },
    addListener(event, listener) {
      guard();
      trackListener(event, listener);
      return bot.addListener(event, listener);
    },
    removeListener(event, listener) {
      guard();
      const idx = trackedListeners.findIndex(
        (entry) => entry.event === event && entry.listener === listener,
      );
      if (idx >= 0) trackedListeners.splice(idx, 1);
      return bot.removeListener(event, listener);
    },
  };

  // Read-only state. Enumerable so Object.keys(bot) lists them in the
  // unexposed-property error message.
  for (const name of [
    "username", "entity", "spawnPoint", "health", "food", "foodSaturation",
    "experience", "time", "game", "world", "registry", "isSleeping",
    "isRaining", "thunderState", "inventory", "heldItem", "currentWindow",
    "usingHeldItem", "quickBarSlot", "targetDigBlock", "players", "entities",
  ]) {
    Object.defineProperty(facade, name, {
      get: () => bot[name],
      enumerable: true,
      configurable: true,
    });
  }

  // Sync pass-throughs (queries, communication, attack, hotbar).
  for (const name of [
    "blockAt", "blockAtCursor", "blockAtEntityCursor", "entityAtCursor",
    "findBlock", "findBlocks", "nearestEntity", "canSeeBlock", "canDigBlock",
    "digTime", "recipesFor", "recipesAll", "chat", "whisper", "attack",
    "activateEntity", "setQuickBarSlot", "mount", "dismount", "getControlState",
    "respawn",
  ]) {
    facade[name] = (...args) => {
      guard();
      return bot[name](...args);
    };
  }

  // Abort-aware awaitables.
  for (const name of [
    "lookAt", "look", "waitForTicks", "waitForChunksToLoad", "placeBlock",
    "activateBlock", "equip", "tossStack", "consume", "craft", "transfer",
    "sleep", "wake",
  ]) {
    facade[name] = awaitable(name);
  }

  // Turn reads of unexposed names into self-documenting errors; symbols
  // and `then` pass through so engine and Promise internals keep working.
  return new Proxy(facade, {
    get(target, property, receiver) {
      if (typeof property === "symbol"
        || property === "then"
        || Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(
        `bot.${property} is not exposed by this facade. `
          + `Use Object.keys(bot) to list available members.`,
      );
    },
  });
}

// Call a function and normalize sync throws into promise rejection.
function callPromise(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

// Track request promises and suppress unhandled fire-and-forget rejections.
function trackPromise(session, promise) {
  session.pendingPromises.add(promise);
  promise.then(
    () => session.pendingPromises.delete(promise),
    () => session.pendingPromises.delete(promise),
  );
  // Attach eagerly, not only during cleanup, so Node never observes a transient
  // unhandled rejection from a fire-and-forget eval call.
  promise.catch(() => {});
  return promise;
}

// Absorb late library-internal rejections after abort wins the race. When
// cleanup (e.g. stopDigging) cancels the operation, mineflayer's internal
// .then-chain rejects with no handler; this terminal .catch silences that.
// Real errors still surface via raceAbort when the call wins the race.
function suppressOriginalPromise(promise) {
  promise.catch(() => {});
}

// ---------------------------------------------------------------------------
// Cleanup / timer scopes

// Create a keyed LIFO cleanup stack for request-scoped undo actions.
function createCleanupStack() {
  const entries = [];
  const keys = new Set();

  return {
    // Add a cleanup action unless this key has already been registered.
    deferOnce(key, fn) {
      if (keys.has(key)) return;
      keys.add(key);
      entries.push(fn);
    },

    // Run pending cleanup actions in reverse registration order, then forget
    // them so a repeated run cannot undo the same intent twice.
    async run() {
      const errors = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        try {
          await entries[i]();
        } catch (error) {
          errors.push(error);
        }
      }
      entries.length = 0;
      keys.clear();
      return errors;
    },
  };
}

// Create a per-request timeout registry for abortable helper timers.
function createTimerScope() {
  const timeouts = new Set();

  return {
    // Schedule a tracked timeout.
    setTimeout(fn, ms, ...args) {
      const handle = setTimeout((...timerArgs) => {
        timeouts.delete(handle);
        fn(...timerArgs);
      }, ms, ...args);
      timeouts.add(handle);
      return handle;
    },

    // Clear one tracked timeout.
    clearTimeout(handle) {
      timeouts.delete(handle);
      return clearTimeout(handle);
    },

    // Clear every timeout still owned by this scope.
    clearAll() {
      for (const handle of timeouts) clearTimeout(handle);
      timeouts.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Eval helpers

// Create the abort-aware sleep helper exposed to eval scripts.
function createSleep(session) {
  return (ms) => {
    const delay = createAbortableDelay(session, ms);
    return trackPromise(session, delay.promise);
  };
}

// Create the abort-aware withTimeout helper exposed to eval scripts.
function createWithTimeout(session) {
  // Race a supplied promise against an abort-aware local timeout.
  return function withTimeout(ms, promise) {
    if (arguments.length < 2) {
      throw new TypeError("withTimeout(ms, promise) requires a promise");
    }

    const delay = createAbortableDelay(session, ms);
    const result = Promise.race([
      Promise.resolve(promise),
      delay.promise.then(() => { throw makeTimeoutError(delay.ms); }),
    ]).finally(delay.cancel);
    return trackPromise(session, result);
  };
}

// Create a delay promise tied to request cleanup and abort state.
function createAbortableDelay(session, ms) {
  const { timers } = session;
  const { signal } = session.deadline;
  const delay = normalizeDelay(ms);
  let settled = false;
  let handle = null;
  let onAbort = null;

  const cleanup = () => {
    if (handle !== null) timers.clearTimeout(handle);
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  };

  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn(value);
  };

  const promise = new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    onAbort = () => settle(reject, signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    handle = timers.setTimeout(() => settle(resolve), delay);
  });

  return {
    ms: delay,
    promise,
    // Cancel the delay without resolving or rejecting it. This is for helper
    // finally paths; request abort is what rejects active awaited helpers.
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}

// Create timer globals that fail with guidance inside eval scripts.
function createDisabledTimers() {
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

// Validate and normalize a delay value.
function normalizeDelay(ms) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new TypeError(`invalid delay: ${ms}`);
  }
  return delay;
}

// Create the local timeout error used by withTimeout.
function makeTimeoutError(ms) {
  const error = new Error(`timeout after ${ms}ms`);
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

// ---------------------------------------------------------------------------
// Chat broadcaster

// Fan player chat out to /listen clients: resolve `@aim`, build the event,
// then write it to every live listener.
function createChatBroadcaster(bot) {
  const clients = new Set();

  bot.on("chat", (username, message, translate, jsonMsg, matches) => {
    if (username === bot.username) return;

    const expanded = expandAimRefs(bot, username, message);
    if (expanded === null) {
      bot.whisper(username, "@aim: no block in sight");
      return;
    }

    broadcastChatEvent(
      clients,
      toChatEvent(username, expanded, translate, jsonMsg, matches),
    );
  });

  return { addClient: (res) => addChatClient(clients, res) };
}

// Build the NDJSON event for one chat message.
function toChatEvent(username, message, translate, jsonMsg, matches) {
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
  return event;
}

// Attach a streaming HTTP response as a chat listener.
function addChatClient(clients, res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  clients.add(res);

  // Keep idle fetch response bodies alive. Empty lines are ignored by clients.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write("\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  res.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

// Replace `@aim` with the (x, y, z) the speaker is looking at. Returns the
// message unchanged when `@aim` is absent, or null when it can't be resolved.
function expandAimRefs(bot, username, message) {
  if (typeof message !== "string" || !message.includes("@aim")) return message;
  const entity = bot.players?.[username]?.entity;
  const block = entity && bot.blockAtEntityCursor(entity, 64);
  if (!block?.position) return null;
  const { x, y, z } = block.position;
  return message.split("@aim").join(`(${x}, ${y}, ${z})`);
}

// Send one chat event as NDJSON to all live listeners.
function broadcastChatEvent(clients, event) {
  const line = JSON.stringify(event) + "\n";
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    client.write(line);
  }
}

// ---------------------------------------------------------------------------
// HTTP utilities

// Read a complete HTTP request body as UTF-8 text.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Write an HTTP response if the socket is still open.
function writeResponse(res, status, contentType, body) {
  if (res.writableEnded) return;
  try {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  } catch {
    // Socket already gone.
  }
}

// Write a JSON response with a trailing newline.
function writeJson(res, status, value) {
  writeResponse(res, status, "application/json", JSON.stringify(value) + "\n");
}

// ---------------------------------------------------------------------------
// Async / abort utilities

// Create a queue that runs asynchronous tasks one at a time.
function createSerialQueue() {
  let tail = Promise.resolve();

  return (task) => {
    // Run the next task after either success or failure of the previous one;
    // a failed eval must not poison the queue.
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

// Create an AbortError annotated with a machine-readable reason.
function makeAbortError(reason) {
  const error = new Error(`aborted: ${reason}`);
  error.name = "AbortError";
  error.reason = reason;
  return error;
}

// Extract the machine-readable abort reason tag.
function abortReasonTag(reason) {
  if (reason && typeof reason === "object" && "reason" in reason) {
    return reason.reason;
  }
  return "abort";
}

// Race a promise against an AbortSignal and optionally cancel on abort.
function raceAbort(signal, promise, onAbort = null) {
  const cancel = () => {
    try {
      if (onAbort) onAbort();
    } catch {
      // Native cancellation is best-effort; the abort reason should remain the
      // visible failure even if cancellation itself throws.
    }
  };

  if (signal.aborted) {
    cancel();
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cancel();
      reject(signal.reason);
    };

    signal.addEventListener("abort", abortHandler, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  main();
}

module.exports = {
  createServer
};
