#!/usr/bin/env node

// Simple mineflayer bot that executes arbitrary JS received over HTTP.
//
// Usage:
//   node mcbot.js [options]
//
// Run with --help to print generated command-line usage.
//
// POST any JS source to http://<http>/eval and it will be evaluated in an
// async function with `bot`, `goals`, `Vec3`, `print`, `sleep`, `withTimeout`,
// and `abort` (an AbortSignal) in scope. Anything the script passes to
// `print(...)` is collected and returned as the response body. The script's
// own return value is ignored.
//
// Eval requests are serialized: one bot control script runs at a time.
//
// Each request is hermetic: behavior/intent state the script introduces
// (control states, pathfinder goals, pvp targets, listeners it adds, timers it
// schedules, open windows, activated items) is rolled back when the script
// settles, when the client disconnects, or when the deadline expires.
// Game/world state (position, health, inventory, broken/placed blocks) is
// never touched.
//
// GET http://<http>/listen streams Minecraft chat messages as
// newline-delimited JSON using chunked transfer encoding.
//
// Keep the HTTP listener bound to localhost unless every client on the network
// is trusted; /eval intentionally executes arbitrary JavaScript.

const http = require("http");
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { loader: autoEat } = require("mineflayer-auto-eat");
const { plugin: pvp } = require("mineflayer-pvp");
const hawkEye = require("minecrafthawkeye").default;
const Vec3 = require("vec3").Vec3;
const util = require("util");

// ---------------------------------------------------------------------------
// Main / CLI

// Start the bot runtime from command-line arguments.
function main() {
  let config;
  try {
    config = parseConfig(process.argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }

  const bot = createMinecraftBot(config);
  const runtime = createRuntime(bot, config);
  const server = createHttpServer(runtime);

  server.listen(config.httpPort, config.httpHost, () => {
    console.log(
      `[http] listening on http://${config.httpHost}:${config.httpPort} `
        + `(/eval, /listen)`,
    );
  });
}

// Convert raw process arguments into normalized runtime configuration.
function parseConfig(argv) {
  const args = parseArgs(argv, "Usage: node mcbot.js [options]", {
    server: ["Minecraft server address", "localhost:25565"],
    user: ["Bot username", "mcbot"],
    http: ["HTTP server bind address", "localhost:3000"],
    timeout: ["Per-request deadline", "120000"],
  });

  const [mcHost, mcPort] = parseHostPort(args.server);
  const [httpHost, httpPort] = parseHostPort(args.http);
  const defaultTimeoutMs = parsePositiveInteger(args.timeout, "--timeout");

  return {
    mcHost,
    mcPort,
    mcUsername: args.user,
    httpHost,
    httpPort,
    defaultTimeoutMs,
  };
}

// Parse string-only --name value arguments from definition metadata.
function parseArgs(argv, epilog, definitions) {
  const args = argv.slice(2);
  const usage = formatUsage(epilog, definitions);
  const values = {};
  const requiredNames = [];

  for (const [name, definition] of Object.entries(definitions)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`invalid argument name: ${name}`);
    }
    if (!Array.isArray(definition) || definition.length < 1
      || definition.length > 2) {
      throw new Error(`invalid definition for --${name}`);
    }
    if (typeof definition[0] !== "string") {
      throw new Error(`invalid description for --${name}`);
    }
    if (definition.length === 1) {
      requiredNames.push(name);
      continue;
    }
    if (typeof definition[1] !== "string") {
      throw new Error(`invalid default for --${name}`);
    }
    values[name] = definition[1];
  }

  const fail = (message) => {
    console.error(`error: ${message}`);
    console.error(usage);
    process.exit(2);
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--help") {
      console.log(usage);
      process.exit(0);
    }

    if (!token.startsWith("--")) {
      fail(`unexpected argument "${token}"`);
    }

    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!name) fail("empty argument name");
    if (!Object.hasOwn(definitions, name)) fail(`unknown argument --${name}`);

    const value = eq >= 0 ? token.slice(eq + 1) : args[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) {
      fail(`missing value for --${name}`);
    }

    values[name] = value;
  }

  for (const name of requiredNames) {
    if (!Object.hasOwn(values, name))
      fail(`missing required argument --${name}`);
  }

  return values;
}

// Build the command-line usage text from argument definitions.
function formatUsage(epilog, definitions) {
  const rows = [
    ...Object.entries(definitions).map(([name, definition]) => {
      const suffix = definition.length === 2
        ? ` (default: ${definition[1]})`
        : " (required)";
      return [`--${name} <value>`, `${definition[0]}${suffix}`];
    }),
    ["--help", "Show this help"],
  ];

  const width = Math.max(...rows.map(([option]) => option.length));
  const options = rows
    .map(([option, description]) => `  ${option.padEnd(width)}  ${description}`)
    .join("\n");

  return `${epilog}\n\nOptions:\n${options}\n`;
}

// Split a host:port string into host and numeric port.
function parseHostPort(value) {
  const idx = value.lastIndexOf(":");
  if (idx < 0) throw new Error(`expected host:port, got "${value}"`);

  const host = value.slice(0, idx);
  const port = parseInt(value.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`invalid host:port "${value}"`);
  }
  return [host, port];
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
    host: config.mcHost,
    port: config.mcPort,
    username: config.mcUsername,
    auth: "offline",
  });

  installBotPlugins(bot);
  installBotLogging(bot);
  return bot;
}

// Attach Mineflayer plugins and one-time plugin setup hooks.
function installBotPlugins(bot) {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(pvp);
  bot.loadPlugin(hawkEye);

  // Eval scripts may temporarily install many listeners. They are removed by
  // request cleanup, so the EventEmitter default of 10 only creates noise.
  bot.setMaxListeners(200);

  bot.once("spawn", () => {
    bot.pathfinder.setMovements(new Movements(bot));
  });
}

// Register process-level logging for bot lifecycle events.
function installBotLogging(bot) {
  bot.on("login", () => console.log(`[bot] logged in as ${bot.username}`));
  bot.on("spawn", () => console.log("[bot] spawned"));
  bot.on("kicked", (reason) => console.log(`[bot] kicked: ${reason}`));
  bot.on("error", (error) => console.log(`[bot] error: ${error.message}`));
  bot.on("end", (reason) => {
    console.log(`[bot] disconnected: ${reason}`);
    process.exit(0);
  });
}

// Bundle long-lived bot, config, queue, and chat state.
function createRuntime(bot, config) {
  return {
    bot,
    config,
    evalQueue: createMutex(),
    chat: createChatBroadcaster(bot),
  };
}

// Public factory for the HTTP control server around an existing bot.
function createServer(bot, config) {
  return createHttpServer(createRuntime(bot, config));
}

// ---------------------------------------------------------------------------
// HTTP server

// Create the HTTP server and protect the request router from uncaught errors.
function createHttpServer(runtime) {
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
    handleListenRequest(runtime, req, res);
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
  if (!req.url) return req.url;
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

  await runtime.evalQueue(() => runEvalSession(runtime, req, res, code));
}

// Attach an HTTP response as a streaming chat listener.
function handleListenRequest(runtime, _req, res) {
  addChatClient(runtime.chat, res);
}

// ---------------------------------------------------------------------------
// Eval session

// Run one complete /eval request lifecycle.
async function runEvalSession(runtime, req, res, code) {
  const session = createEvalSession(runtime, req, res);
  let scriptError = null;
  let cleanupErrors = [];

  try {
    installRequestPatches(session);
    await raceAbort(
      session.signal,
      executeUserCode(buildEvalContext(session), code),
      null,
    );
  } catch (error) {
    scriptError = error;
  } finally {
    cleanupErrors = await finishEvalSession(session);
  }

  writeEvalResult(session, scriptError, cleanupErrors);
}

// Create all request-scoped state used by an eval session.
function createEvalSession(runtime, req, res) {
  const controller = new AbortController();
  const { signal } = controller;
  const output = [];
  const deadline = setTimeout(() => {
    if (!signal.aborted) controller.abort(makeAbortError("deadline"));
  }, runtime.config.defaultTimeoutMs);

  if (typeof deadline.unref === "function") deadline.unref();

  const onClose = () => {
    if (!res.writableEnded && !signal.aborted) {
      controller.abort(makeAbortError("client-disconnect"));
    }
  };
  // Listen on res, not req: after the body is drained, req.close is not a
  // reliable client-disconnect signal, but res.close still follows the socket.
  res.on("close", onClose);

  return {
    runtime,
    bot: runtime.bot,
    config: runtime.config,
    req,
    res,
    controller,
    signal,
    deadline,
    onClose,
    output,
    cleanup: createCleanupStack(),
    timers: createTimerScope(),
    patches: createPatchSet(),
    pendingPromises: new Set(),
  };
}

// Build the sandbox-visible bindings for user code.
function buildEvalContext(session) {
  return {
    bot: createAbortGuardedProxy(session, session.bot),
    goals,
    Vec3,
    print: (...args) => session.output.push(util.format(...args)),
    sleep: createSleep(session),
    withTimeout: createWithTimeout(session),
    abort: session.signal,
    timers: createBlockedTimers(),
  };
}

// Execute user JavaScript in an async wrapper with scoped globals.
async function executeUserCode(context, code) {
  // Return values are deliberately ignored; print(...) is the only output
  // channel. Timer names are parameters so eval code sees our blocked versions
  // instead of Node's process-wide timer globals.
  const body = `return (async () => { ${code} })();`;
  const fn = new Function(
    "bot", "goals", "Vec3", "print", "sleep", "withTimeout", "abort",
    "setTimeout", "clearTimeout",
    "setInterval", "clearInterval",
    "setImmediate", "clearImmediate",
    body,
  );

  await fn(
    context.bot,
    context.goals,
    context.Vec3,
    context.print,
    context.sleep,
    context.withTimeout,
    context.abort,
    context.timers.setTimeout,
    context.timers.clearTimeout,
    context.timers.setInterval,
    context.timers.clearInterval,
    context.timers.setImmediate,
    context.timers.clearImmediate,
  );
}

// Abort outstanding request work, run cleanup, and restore patches.
async function finishEvalSession(session) {
  clearTimeout(session.deadline);
  session.res.off("close", session.onClose);

  // Force request-scoped awaitables and helpers to observe completion before
  // cleanup runs. On a normal success/error this reason is intentionally
  // "script-end" and is not reported to the client.
  if (!session.signal.aborted) {
    session.controller.abort(makeAbortError("script-end"));
  }

  const cleanupErrors = await session.cleanup.run();

  // Fire-and-forget patched calls may still reject after the script exits;
  // terminal catches keep those expected abort rejections out of process logs.
  for (const promise of session.pendingPromises) {
    promise.catch(() => {});
  }
  session.pendingPromises.clear();

  session.patches.restore();
  return cleanupErrors;
}

// Translate session outcome into the final HTTP response.
function writeEvalResult(session, scriptError, cleanupErrors) {
  const reason = abortReasonTag(session.signal.reason);

  if (reason === "client-disconnect") {
    if (scriptError) {
      console.log(`[eval] client gone, script error: ${scriptError.message}`);
    }
    return;
  }

  if (scriptError && !isAbortError(scriptError)) {
    writeJson(session.res, 500, {
      error: scriptError.message,
      stack: scriptError.stack,
      output: session.output.join("\n"),
      cleanupErrors: cleanupErrors.map((error) => error.message),
    });
    return;
  }

  if (reason === "deadline") {
    writeJson(session.res, 504, {
      error: "deadline exceeded",
      output: session.output.join("\n"),
      cleanupErrors: cleanupErrors.map((error) => error.message),
    });
    return;
  }

  writeResponse(
    session.res,
    200,
    "text/plain",
    session.output.join("\n") + (session.output.length ? "\n" : ""),
  );
}

// ---------------------------------------------------------------------------
// Request patches

// Create a bot facade that prevents detached eval continuations from touching
// the real bot after the request has aborted. Sub-objects are recursively
// proxied through a per-session cache so identity is stable within a request.
function createAbortGuardedProxy(session, root) {
  const { signal } = session;
  const cache = new WeakMap();

  function wrap(target) {
    if (target === null
      || (typeof target !== "object" && typeof target !== "function")
      || target instanceof Promise) {
      return target;
    }
    if (cache.has(target)) return cache.get(target);

    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        signal.throwIfAborted();
        const value = Reflect.get(object, property, receiver);
        if (typeof value === "function") {
          // Re-check at call time so methods captured into local variables
          // before abort cannot be invoked afterwards. Bind to the real
          // object so library internals see the unwrapped this.
          return (...args) => {
            signal.throwIfAborted();
            return Reflect.apply(value, object, args);
          };
        }
        return wrap(value);
      },
      set(object, property, value, receiver) {
        signal.throwIfAborted();
        return Reflect.set(object, property, value, receiver);
      },
      deleteProperty(object, property) {
        signal.throwIfAborted();
        return Reflect.deleteProperty(object, property);
      },
    });

    cache.set(target, proxy);
    return proxy;
  }

  return wrap(root);
}

// Install all per-request bot behavior patches.
function installRequestPatches(session) {
  patchControlState(session);
  patchListeners(session);
  patchBotAwaitables(session);
  patchDigging(session);
  patchContainers(session);
  patchPathfinder(session);
  patchCombat(session);
  patchItemUse(session);

  session.cleanup.deferOnce("timers", session.timers.clearAll);
}

// Patch movement controls so active states are reset on cleanup.
function patchControlState(session) {
  patchMethod(session, session.bot, "setControlState", (original) => (
    state,
    value,
  ) => {
    if (value) {
      session.cleanup.deferOnce(
        `control:${state}`,
        () => original(state, false),
      );
    }
    return original(state, value);
  });
}

// Patch listener registration so request-added listeners are removed.
function patchListeners(session) {
  const added = [];

  session.cleanup.deferOnce("listeners", () => {
    const errors = [];
    for (const { event, listener } of added) {
      try {
        session.bot.removeListener(event, listener);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  });

  const track = (event, listener) => added.push({ event, listener });

  // Track once() as well: if it never fires, EventEmitter will not remove it
  // for us before the request ends.
  for (const method of ["on", "addListener", "once"]) {
    patchMethod(
      session,
      session.bot,
      method,
      (original) => (event, listener) => {
        track(event, listener);
        return original(event, listener);
      },
    );
  }
}

// Patch common awaitable bot methods to reject on request abort.
function patchBotAwaitables(session) {
  for (const method of [
    "equip", "unequip", "toss", "tossStack", "consume",
    "craft", "placeBlock", "activateBlock", "lookAt",
  ]) {
    patchAwaitable(session, session.bot, method);
  }
}

// Patch digging so aborts invoke Mineflayer's native stop hook.
function patchDigging(session) {
  patchCancelable(session, session.bot, "dig", "dig", () => {
    if (session.bot.stopDigging) session.bot.stopDigging();
  });
}

// Patch container-opening methods so opened windows are closed.
function patchContainers(session) {
  for (const method of ["openContainer", "openChest"]) {
    patchMethod(session, session.bot, method, (original) => (...args) => {
      if (session.signal.aborted) return Promise.reject(session.signal.reason);
      const originalPromise = callPromise(original, args);
      suppressOriginalPromise(originalPromise);
      const opening = originalPromise.then((window) => {
        if (window) {
          session.cleanup.deferOnce(`window:${window.id ?? method}`, () => {
            // Only close the window this request opened; do not close a newer
            // current window that may have replaced it.
            if (session.bot.currentWindow === window) {
              session.bot.closeWindow(window);
            }
          });
        }
        return window;
      });
      return trackPromise(session, raceAbort(session.signal, opening, null));
    });
  }
}

// Patch pathfinder goals so navigation intent is cleared.
function patchPathfinder(session) {
  const pathfinderApi = session.bot.pathfinder;

  // goto(...) and setGoal(...) both latch the same navigation intent, so they
  // share one cleanup key and one final setGoal(null).
  patchCancelable(session, pathfinderApi, "goto", "pathfinder:goal", () => {
    if (pathfinderApi && pathfinderApi.setGoal) pathfinderApi.setGoal(null);
  });

  patchMethod(
    session,
    pathfinderApi,
    "setGoal",
    (original) => (goal, dynamic) => {
      if (goal !== null && goal !== undefined) {
        session.cleanup.deferOnce("pathfinder:goal", () => original(null));
      }
      return original(goal, dynamic);
    },
  );
}

// Patch PvP attack state so combat is stopped on cleanup.
function patchCombat(session) {
  patchMethod(session, session.bot.pvp, "attack", (original) => (...args) => {
    session.cleanup.deferOnce("pvp", () => {
      if (session.bot.pvp && session.bot.pvp.stop) session.bot.pvp.stop();
    });
    return original(...args);
  });
}

// Patch item activation so held-item use is deactivated.
function patchItemUse(session) {
  patchMethod(session, session.bot, "activateItem", (original) => (...args) => {
    session.cleanup.deferOnce("activateItem", () => {
      if (session.bot.deactivateItem) session.bot.deactivateItem();
    });
    return original(...args);
  });
}

// Replace one method through the session patch set when it exists.
function patchMethod(session, target, method, wrap) {
  if (!target || typeof target[method] !== "function") return false;
  session.patches.add(target, method, wrap);
  return true;
}

// Wrap an awaitable method with abort racing and promise tracking.
function patchAwaitable(session, target, method) {
  patchMethod(session, target, method, (original) => (...args) => {
    if (session.signal.aborted) return Promise.reject(session.signal.reason);
    const promise = callPromise(original, args);
    suppressOriginalPromise(promise);
    return trackPromise(session, raceAbort(session.signal, promise, null));
  });
}

// Wrap an awaitable method that has an explicit cancellation action.
function patchCancelable(session, target, method, cleanupKey, cancel) {
  patchMethod(session, target, method, (original) => (...args) => {
    if (session.signal.aborted) return Promise.reject(session.signal.reason);
    session.cleanup.deferOnce(cleanupKey, cancel);
    const promise = callPromise(original, args);
    suppressOriginalPromise(promise);
    return trackPromise(session, raceAbort(session.signal, promise, () => {
      // Abort runs native cancellation immediately; mark the cleanup discharged
      // so the finally path does not repeat the same cancellation.
      cancel();
      session.cleanup.markDone(cleanupKey);
    }));
  });
}

// Call a function and normalize sync throws into promise rejection.
function callPromise(fn, args) {
  try {
    return Promise.resolve(fn(...args));
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

// Suppress late rejections from underlying library promises after the request
// abort race has already settled. raceAbort attaches .then(v, e) to the
// outermost promise we get back from a mineflayer call, but the libraries
// build internal .then-chains and event-driven sub-promises we never see;
// when our cleanup (e.g. bot.stopDigging()) cancels the operation after the
// wrapper has already rejected with the abort, those library-internal
// descendants reject with no handler attached. This terminal .catch marks the
// whole library-managed chain as observed. The wrapper still surfaces real
// errors to awaited eval code when the underlying operation wins the race.
function suppressOriginalPromise(promise) {
  promise.catch(() => {});
}

// ---------------------------------------------------------------------------
// Cleanup / patch scopes

// Create a keyed LIFO cleanup stack for request-scoped undo actions.
function createCleanupStack() {
  const entries = [];
  const keys = new Map();

  return {
    // Add a cleanup action unless this key has already been registered.
    deferOnce(key, fn) {
      if (keys.has(key)) return;
      const entry = { key, fn, done: false };
      keys.set(key, entry);
      entries.push(entry);
    },

    // Mark a cleanup action as already completed.
    markDone(key) {
      const entry = keys.get(key);
      if (entry) entry.done = true;
    },

    // Run pending cleanup actions in reverse registration order.
    async run() {
      const errors = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.done) continue;
        entry.done = true;
        try {
          await entry.fn();
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
  };
}

// Create a method patch set that can restore originals in reverse order.
function createPatchSet() {
  const originals = [];

  return {
    // Patch one method and remember its original implementation.
    add(target, method, wrap) {
      const original = target[method];
      originals.push({ target, method, original });
      target[method] = wrap(original.bind(target), original);
    },

    // Restore all patched methods in reverse patch order.
    restore() {
      for (let i = originals.length - 1; i >= 0; i--) {
        const { target, method, original } = originals[i];
        target[method] = original;
      }
      originals.length = 0;
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
  return (ms, value) => {
    const delay = createAbortableDelay(session.timers, session.signal, ms);
    return trackPromise(session, delay.promise.then(() => value));
  };
}

// Create the abort-aware withTimeout helper exposed to eval scripts.
function createWithTimeout(session) {
  // Race a supplied promise against an abort-aware local timeout.
  return function withTimeout(ms, promise) {
    if (arguments.length < 2) {
      throw new TypeError("withTimeout(ms, promise) requires a promise");
    }

    const delay = createAbortableDelay(session.timers, session.signal, ms);
    const result = Promise.race([
      Promise.resolve(promise),
      delay.promise.then(() => { throw makeTimeoutError(delay.ms); }),
    ]).finally(delay.cancel);
    return trackPromise(session, result);
  };
}

// Create a delay promise tied to request cleanup and abort state.
function createAbortableDelay(timers, signal, ms) {
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

// Create chat event fan-out state and connect it to the bot chat event.
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

    broadcastChatEvent(clients, event);
  });

  return { clients };
}

// Add a streaming HTTP response to the chat broadcaster.
function addChatClient(chat, res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Transfer-Encoding": "chunked",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  chat.clients.add(res);

  // Keep idle fetch response bodies alive. Empty lines are ignored by clients.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write("\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  res.on("close", () => {
    clearInterval(heartbeat);
    chat.clients.delete(res);
  });
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

// Create a promise queue that serializes asynchronous tasks.
function createMutex() {
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

// Detect abort-style errors from local or platform sources.
function isAbortError(error) {
  return error && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

// Return a promise that rejects when an AbortSignal aborts.
function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason),
      { once: true },
    );
  });
}

// Race a promise against an AbortSignal and optionally cancel on abort.
function raceAbort(signal, promise, onAbort) {
  if (signal.aborted) {
    try {
      if (onAbort) onAbort();
    } catch {
      // Native cancellation is best-effort; the abort reason should remain the
      // visible failure even if cancellation itself throws.
    }
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      try {
        if (onAbort) onAbort();
      } catch {
        // Native cancellation is best-effort; the abort reason should remain
        // the visible failure even if cancellation itself throws.
      }
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
