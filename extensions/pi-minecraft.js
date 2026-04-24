const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

module.exports = function minecraftExtension(pi) {
  const packageRoot = path.resolve(__dirname, "..");
  const botScript = path.join(packageRoot, "mcbot.js");
  const systemPromptPath = path.join(packageRoot, "system.md");
  let chatListener = null;

  pi.on("session_shutdown", async (_event, ctx) => {
    stopChatListener(chatListener);
    chatListener = null;
    if (ctx && ctx.cwd) await stopManagedBot(ctx.cwd, botScript);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = await readStateIfExists(ctx.cwd);
    if (!state) return;
    if (!isManagedProcess(state.pid, botScript)) {
      clearState(ctx.cwd);
      return;
    }

    const systemPrompt = await fs.promises.readFile(systemPromptPath, "utf8");
    const http = state.http || "localhost:3000";
    const runtimeContext = [
      "# Active Minecraft Bot Runtime",
      "",
      `- HTTP endpoint: http://${http}/eval`,
      `- PID: ${state.pid}`,
      `- Log: ${relative(ctx.cwd, state.logPath || getLogPath(ctx.cwd))}`,
    ].join("\n");

    return {
      systemPrompt: [
        event.systemPrompt,
        systemPrompt,
        runtimeContext,
      ].join("\n\n"),
    };
  });

  pi.registerCommand("minecraft:start", {
    description: "Start the Mineflayer mcbot background process",
    handler: async (args, ctx) => {
      const state = await readState(ctx.cwd);
      if (state && isManagedProcess(state.pid, botScript)) {
        chatListener = ensureChatListener(
          pi,
          ctx,
          chatListener,
          state.http || "localhost:3000",
        );
        notify(
          ctx,
          `mcbot already running: pid ${state.pid}; listening for chat`,
          "info",
        );
        return;
      }

      const runtimeDir = ensureRuntimeDir(ctx.cwd);
      const logPath = path.join(runtimeDir, "mcbot.log");
      const out = fs.openSync(logPath, "a");
      const err = fs.openSync(logPath, "a");
      const botArgs = parseShellArgs(args || "");
      const child = spawn(process.execPath, [botScript, ...botArgs], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ["ignore", out, err],
        env: process.env,
      });

      child.unref();
      fs.closeSync(out);
      fs.closeSync(err);

      const nextState = {
        pid: child.pid,
        startedAt: new Date().toISOString(),
        cwd: ctx.cwd,
        command: [process.execPath, botScript, ...botArgs],
        http: getHttpAddress(botArgs),
        logPath,
      };
      writeState(ctx.cwd, nextState);

      const probe = await waitForEvalReady(
        nextState.http,
        child.pid,
        botScript,
        10000,
      );
      if (probe.status === "ready") {
        chatListener = ensureChatListener(pi, ctx, chatListener, nextState.http);
        notify(
          ctx,
          `started mcbot: pid ${child.pid}; /eval is ready; `
            + `listening for Minecraft chat; bot instructions will be `
            + `injected into future prompts; log ${relative(ctx.cwd, logPath)}`,
          "success",
        );
        return;
      }

      if (probe.status === "exited") {
        clearState(ctx.cwd);
        notify(
          ctx,
          `mcbot exited before /eval became ready; `
            + `log ${relative(ctx.cwd, logPath)}`,
          "error",
        );
        return;
      }

      notify(
        ctx,
        `started mcbot: pid ${child.pid}, but /eval did not become `
          + `ready within 10 seconds; Minecraft bot instructions will be `
          + `injected into future prompts; log ${relative(ctx.cwd, logPath)}`,
        "warning",
      );
    },
  });

  pi.registerCommand("minecraft:stop", {
    description: "Stop the background mcbot process",
    handler: async (_args, ctx) => {
      const state = await readState(ctx.cwd);
      if (!state || !isManagedProcess(state.pid, botScript)) {
        clearState(ctx.cwd);
        notify(ctx, "mcbot is not running", "info");
        return;
      }

      stopChatListener(chatListener);
      chatListener = null;
      await stopManagedBot(ctx.cwd, botScript);
      notify(
        ctx,
        `stopped mcbot: pid ${state.pid}; Minecraft bot instructions disabled`,
        "success",
      );
    },
  });

  pi.registerCommand("minecraft:status", {
    description: "Show background mcbot process status",
    handler: async (_args, ctx) => {
      const state = await readState(ctx.cwd);
      if (!state) {
        notify(ctx, "mcbot status: not running", "info");
        return;
      }

      const running = isManagedProcess(state.pid, botScript);
      if (!running) {
        clearState(ctx.cwd);
        notify(
          ctx,
          `mcbot status: stale pid ${state.pid}; cleaned state`,
          "warning",
        );
        return;
      }

      const http = state.http || "localhost:3000";
      const reachable = await isHttpReachable(http);
      const listening = chatListener && chatListener.hostPort === http;
      const lines = [
        `mcbot status: running`,
        `pid: ${state.pid}`,
        `started: ${state.startedAt || "unknown"}`,
        `http: http://${http}/eval `
          + `(${reachable ? "reachable" : "not reachable yet"})`,
        `chat listener: ${listening ? "connected" : "not connected"}`,
        `log: ${relative(ctx.cwd, state.logPath || getLogPath(ctx.cwd))}`,
      ];
      notify(ctx, lines.join("\n"), reachable ? "success" : "warning");
    },
  });
};

async function stopManagedBot(cwd, botScript) {
  const state = await readState(cwd);
  if (!state) return { status: "not-running" };
  if (!isManagedProcess(state.pid, botScript)) {
    clearState(cwd);
    return { status: "stale", pid: state.pid };
  }

  signalProcess(state.pid, "SIGTERM");
  const stopped = await waitForExit(state.pid, 3000);
  if (!stopped && isManagedProcess(state.pid, botScript)) {
    signalProcess(state.pid, "SIGKILL");
    await waitForExit(state.pid, 1000);
  }
  clearState(cwd);
  return { status: "stopped", pid: state.pid };
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
}

function ensureChatListener(pi, ctx, current, hostPort) {
  if (current && current.hostPort === hostPort) return current;
  stopChatListener(current);

  const controller = new AbortController();
  const listener = { hostPort, controller };
  runChatListener(pi, ctx, hostPort, controller.signal).catch((error) => {
    if (controller.signal.aborted) return;
    notify(ctx, `Minecraft chat listener stopped: ${error.message}`, "error");
  });
  return listener;
}

function stopChatListener(listener) {
  if (listener && listener.controller) listener.controller.abort();
}

async function runChatListener(pi, ctx, hostPort, signal) {
  const response = await fetch(`http://${hostPort}/listen`, { signal });
  if (!response.ok) {
    throw new Error(`GET /listen failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("GET /listen returned no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) throw new Error("GET /listen ended");
    buffered += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) sendChatTurn(pi, ctx, line);
    }
  }
}

function sendChatTurn(pi, ctx, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    notify(ctx, `Ignoring malformed Minecraft chat event: ${line}`, "warning");
    return;
  }
  if (event.type !== "chat" || typeof event.message !== "string") return;

  const username = event.username || "unknown";
  const prompt = `Minecraft chat message from ${username}: ${event.message}`;
  try {
    if (ctx && typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(prompt);
    }
  } catch (error) {
    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch (fallbackError) {
      notify(
        ctx,
        `Failed to queue Minecraft chat message: ${fallbackError.message}`,
        "error",
      );
    }
  }
}

function getRuntimeDir(cwd) {
  return path.join(cwd, ".pi", "minecraft");
}

function ensureRuntimeDir(cwd) {
  const dir = getRuntimeDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStatePath(cwd) {
  return path.join(getRuntimeDir(cwd), "mcbot.json");
}

function getLogPath(cwd) {
  return path.join(getRuntimeDir(cwd), "mcbot.log");
}

async function readState(cwd) {
  const state = await readStateIfExists(cwd);
  if (state === null) return null;
  return state;
}

async function readStateIfExists(cwd) {
  try {
    return JSON.parse(await fs.promises.readFile(getStatePath(cwd), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeState(cwd, state) {
  ensureRuntimeDir(cwd);
  fs.writeFileSync(getStatePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

function clearState(cwd) {
  try { fs.unlinkSync(getStatePath(cwd)); } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function isManagedProcess(pid, botScript) {
  if (!isPidRunning(pid)) return false;
  // On Linux, avoid killing an unrelated process if a stale PID was reused.
  // On other platforms or if /proc is inaccessible, fall back to kill(pid, 0).
  try {
    const cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ");
    return cmdline.includes(botScript)
      || cmdline.includes(path.basename(botScript));
  } catch {
    return true;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidRunning(pid);
}

async function waitForEvalReady(hostPort, pid, botScript, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isManagedProcess(pid, botScript)) return { status: "exited" };
    if (await probeEval(hostPort)) return { status: "ready" };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!isManagedProcess(pid, botScript)) return { status: "exited" };
  return { status: "timeout" };
}

async function isHttpReachable(hostPort) {
  return probeEval(hostPort);
}

async function probeEval(hostPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(`http://${hostPort}/eval`, {
      method: "POST",
      body: 'print("ok")',
      signal: controller.signal,
    });
    return res.ok && (await res.text()) === "ok\n";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function getHttpAddress(args) {
  const idx = args.indexOf("--http");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const eq = args.find((arg) => arg.startsWith("--http="));
  if (eq) return eq.slice("--http=".length);
  return "localhost:3000";
}

function parseShellArgs(input) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`unterminated ${quote} quote in arguments`);
  if (current) args.push(current);
  return args;
}

function relative(cwd, target) {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith("..") ? rel : target;
}

function notify(ctx, message, level) {
  if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
  } else {
    console.log(message);
  }
}
