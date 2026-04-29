const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createServer } = require("../mcbot.js");

// These tests exercise the /eval runtime without a real Minecraft server. The
// fake bot implements only the Mineflayer surface that mcbot.js patches.

test("/eval returns print output and ignores return values", async (t) => {
  const { url } = await createFixture(t);

  assert.deepEqual(await post(url, "print('ok')"), {
    status: 200,
    body: "ok\n",
  });
  assert.deepEqual(await post(url, "return 'hidden'"), {
    status: 200,
    body: "",
  });
});

test("/eval reports runtime and syntax errors as JSON", async (t) => {
  const { url } = await createFixture(t);

  const runtime = await post(url, "print('before'); throw new Error('boom')");
  assert.equal(runtime.status, 500);
  assertJsonSubset(runtime.body, {
    error: "boom",
    output: "before",
    cleanupErrors: [],
  });

  const syntax = await post(url, "if (");
  assert.equal(syntax.status, 500);
  assert.match(JSON.parse(syntax.body).error, /Unexpected token/);
});

test("wrong HTTP method/path return 404", async (t) => {
  const { url } = await createFixture(t);

  assert.deepEqual(await request("GET", url), {
    status: 404,
    body: "POST JS to /eval or GET /listen\n",
  });
  assert.deepEqual(
    await request("POST", url.replace("/eval", "/wrong"), "print('x')"),
    {
    status: 404,
    body: "POST JS to /eval or GET /listen\n",
  });
});

test("/listen streams chat messages as NDJSON chunks", async (t) => {
  const { bot, listenUrl } = await createFixture(t);
  const controller = new AbortController();

  const response = await fetch(listenUrl, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type"),
    /^application\/x-ndjson/,
  );

  const first = readNextLine(response.body.getReader());
  bot.emit("chat", "Steve", "hello from chat");

  const event = JSON.parse(await first);
  assert.equal(event.type, "chat");
  assert.equal(event.username, "Steve");
  assert.equal(event.message, "hello from chat");
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  controller.abort();
});

test("/listen filters out the bot's own chat messages", async (t) => {
  const { bot, listenUrl } = await createFixture(t);
  const controller = new AbortController();
  bot.username = "mcbot";

  const response = await fetch(listenUrl, { signal: controller.signal });
  assert.equal(response.status, 200);

  const next = readNextLine(response.body.getReader());
  bot.emit("chat", "mcbot", "ignore me");
  assert.equal(
    await Promise.race([
      next.then(() => "line"),
      delay(30).then(() => "timeout"),
    ]),
    "timeout",
  );

  bot.emit("chat", "Alex", "deliver me");
  const event = JSON.parse(await next);
  assert.equal(event.username, "Alex");
  assert.equal(event.message, "deliver me");

  controller.abort();
});

test("/listen expands @aim to the block the player is looking at", async (t) => {
  const { bot, listenUrl } = await createFixture(t);
  const controller = new AbortController();

  bot.players = { Steve: { entity: { username: "Steve" } } };
  bot.blockAtEntityCursor = (entity) => entity === bot.players.Steve.entity
    ? { position: { x: 10, y: 64, z: 5 } }
    : null;

  const response = await fetch(listenUrl, { signal: controller.signal });
  const next = readNextLine(response.body.getReader());
  bot.emit("chat", "Steve", "go to @aim and mine @aim");

  const event = JSON.parse(await next);
  assert.equal(event.message, "go to (10, 64, 5) and mine (10, 64, 5)");

  controller.abort();
});

test("/listen suppresses unresolved @aim and whispers back", async (t) => {
  const { bot, listenUrl } = await createFixture(t);
  const controller = new AbortController();

  // bot.players / bot.world unset: aim cannot be resolved.
  const response = await fetch(listenUrl, { signal: controller.signal });
  const next = readNextLine(response.body.getReader());

  bot.emit("chat", "Steve", "head to @aim");
  bot.emit("chat", "Steve", "hello world");

  // The unresolved @aim message is dropped; the next plain message is
  // delivered, proving the broadcaster did not forward the @aim event.
  const event = JSON.parse(await next);
  assert.equal(event.message, "hello world");
  assert.deepEqual(
    bot.calls.filter((call) => call.name === "whisper"),
    [{ name: "whisper", args: ["Steve", "@aim: no block in sight"] }],
  );

  controller.abort();
});

test("empty and unicode bodies are handled", async (t) => {
  const { url } = await createFixture(t);

  assert.deepEqual(await post(url, ""), { status: 200, body: "" });
  assert.deepEqual(await post(url, "print('unicode ☃ ok')"), {
    status: 200,
    body: "unicode ☃ ok\n",
  });
});

test("user snippets are loaded fresh on each eval", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcbot-snippets-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const snippetsPath = path.join(dir, "snippets.js");
  await fs.writeFile(snippetsPath, "exports.answer = () => 1;\n");

  const { url } = await createFixture(t, { snippetsPath });
  const initial = await post(
    url,
    "print('answer', snippets.answer(), 'bot', 'snippets' in bot)",
  );
  assert.deepEqual(initial, {
    status: 200,
    body: "answer 1 bot false\n",
  });

  await fs.writeFile(
    snippetsPath,
    "exports.answer = () => 2;\nexports.label = 'fresh';\n",
  );
  const fresh = await post(
    url,
    "print('answer', snippets.answer(), snippets.label)",
  );
  assert.deepEqual(fresh, { status: 200, body: "answer 2 fresh\n" });
});

test("missing user snippets file provides empty snippets object", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcbot-snippets-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { url } = await createFixture(t, {
    snippetsPath: path.join(dir, "missing.js"),
  });

  const response = await post(
    url,
    "print(typeof snippets, Object.keys(snippets).length)",
  );
  assert.deepEqual(response, { status: 200, body: "object 0\n" });
});

test("failing user snippets import reports a JSON eval error", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcbot-snippets-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const snippetsPath = path.join(dir, "snippets.js");
  await fs.writeFile(snippetsPath, "throw new Error('bad snippets')\n");

  const { url } = await createFixture(t, { snippetsPath });
  const response = await post(url, "print('not reached')");

  assert.equal(response.status, 500);
  assertJsonSubset(response.body, {
    error: "bad snippets",
    output: "",
    cleanupErrors: [],
  });
});

test("withTimeout rejects locally and raw timers are blocked", async (t) => {
  const { url } = await createFixture(t);

  assert.deepEqual(
    await post(url, `
      try { await withTimeout(10, sleep(1000)) }
      catch (error) { print(error.name + ':' + error.message) }
    `),
    { status: 200, body: "TimeoutError:timeout after 10ms\n" },
  );

  const timer = await post(url, "setTimeout(() => print('late'), 1)");
  assert.equal(timer.status, 500);
  assert.match(
    JSON.parse(timer.body).error,
    /setTimeout is disabled in \/eval/,
  );
});

test("server deadline aborts sleep and cleans temporary state", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 30 });

  const response = await post(url, `
    bot.setControlState('jump', true)
    bot.on('physicTick', () => {})
    await sleep(1000)
  `);

  assert.equal(response.status, 504);
  assertJsonSubset(response.body, {
    error: "deadline exceeded",
    output: "",
    cleanupErrors: [],
  });
  assert.equal(bot.controlState.jump, false);
  assert.equal(bot.listenerCount("physicTick"), 1);
});

test("temporary state is cleaned after success and "
  + "after script errors", async (t) => {
  const { bot, url } = await createFixture(t);

  assert.equal(
    (await post(url, mutateTemporaryState("print('mutated')"))).status,
    200,
  );
  assertClean(bot);

  const response = await post(
    url,
    mutateTemporaryState("throw new Error('cleanup-check')"),
  );
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.body).error, "cleanup-check");
  assertClean(bot);
});

test("unexposed bot members produce a self-documenting error", async (t) => {
  const { url } = await createFixture(t);

  const response = await post(url, "print(bot.notARealMethod)");
  assert.equal(response.status, 500);
  const payload = JSON.parse(response.body);
  assert.match(payload.error, /bot\.notARealMethod is not exposed/);
  assert.match(payload.error, /Object\.keys\(bot\)/);
});

test("once listeners that never fire are removed", async (t) => {
  const { bot, url } = await createFixture(t);

  const response = await post(url, "bot.once('rain', () => {}); print('ok')");

  assert.deepEqual(response, { status: 200, body: "ok\n" });
  assert.equal(bot.listenerCount("rain"), 0);
});

test("large listener batches are cleaned", async (t) => {
  const { bot, url } = await createFixture(t);

  const response = await post(
    url,
    "for (let i = 0; i < 190; i++) bot.on('physicTick', () => {}); print('ok')",
  );

  assert.equal(response.status, 200);
  assert.equal(response.body, "ok\n");
  assert.equal(bot.listenerCount("physicTick"), 1);
});

test("requests are serialized", async (t) => {
  const { url } = await createFixture(t);

  const first = post(
    url,
    "print('first-start'); await sleep(80); print('first-end')",
  );
  await delay(10);

  const secondStarted = Date.now();
  const second = post(url, "print('second')");
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.deepEqual(firstResponse, {
    status: 200,
    body: "first-start\nfirst-end\n",
  });
  assert.deepEqual(secondResponse, { status: 200, body: "second\n" });
  assert(
    Date.now() - secondStarted >= 60,
    "second request should wait behind first",
  );
});

test("client disconnect aborts the request, cleans up, and "
  + "releases the queue", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 1000 });

  const abandoned = abandonPost(url, `
    bot.setControlState('jump', true)
    bot.on('physicTick', () => {})
    await sleep(10000)
  `, 20);
  await delay(5);

  const queuedStarted = Date.now();
  const queued = await post(url, "print('queued-ran')");

  await abandoned;
  assert.equal(queued.status, 200);
  assert.equal(queued.body, "queued-ran\n");
  assert(
    Date.now() - queuedStarted < 500,
    "queue should not wait for the full deadline",
  );
  assertClean(bot);
});

test("client disconnect does not leak helper promise abort rejections", async (t) => {
  const { url } = await createFixture(t, { defaultTimeoutMs: 1000 });
  const observed = observeUnhandledRejection();

  try {
    await abandonPost(url, `
      sleep(10000)
      await sleep(10000)
    `, 20);

    const reason = await Promise.race([
      observed.promise,
      delay(50).then(() => null),
    ]);
    assert.equal(reason, null, reason && reason.stack || String(reason));
  } finally {
    observed.cleanup();
  }
});

test("detached eval continuation cannot mutate bot after abort", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 1000 });

  await abandonPost(url, `
    const setControlState = bot.setControlState
    try { await sleep(10000) } catch {}
    for (const action of [
      () => bot.setControlState('jump', true),
      () => setControlState('jump', true),
    ]) {
      try { action() } catch {}
    }
  `, 20);
  await delay(50);

  assert.equal(!!bot.controlState.jump, false);
});

test("client disconnect suppresses nested dig abort rejections", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 1000 });
  bot.lookAt = () => new Promise(() => {});
  bot.dig = async () => {
    await bot.lookAt({ x: 1, y: 2, z: 3 });
  };

  const observed = observeUnhandledRejection();
  try {
    await abandonPost(url, "await bot.dig({ name: 'test_block' })", 20);

    const reason = await Promise.race([
      observed.promise,
      delay(50).then(() => null),
    ]);
    assert.equal(reason, null, reason && reason.stack || String(reason));
  } finally {
    observed.cleanup();
  }
});

test("fire-and-forget awaitables are aborted and cleaned", async (t) => {
  const { bot, url } = await createFixture(t);

  const response = await post(url, `
    bot.dig({ name: 'test_block' })
    print('started')
  `);

  assert.deepEqual(response, { status: 200, body: "started\n" });
  // dig hangs forever in the fake; cleanup must call stopDigging on script
  // end so the underlying intent is released.
  assert.equal(bot.diggingStopped, true);
});

test("open windows and activated items are cleaned", async (t) => {
  const { bot, url } = await createFixture(t);

  const response = await post(url, `
    await bot.openContainer({})
    bot.activateItem()
    print('window', !!bot.currentWindow)
    print('using', !!bot.usingHeldItem)
  `);

  assert.equal(response.status, 200);
  assert.equal(response.body, "window true\nusing true\n");
  assert.equal(bot.currentWindow, null);
  assert.equal(bot.usingHeldItem, false);
});

test("lookAt abort recovery", async (t) => {
  const { url } = await createFixture(t, { defaultTimeoutMs: 1000 });

  await abandonPost(url, `
    for (let i = 0; i < 1000; i++) {
      await bot.lookAt({ x: i, y: 2, z: 0 })
      await sleep(10)
    }
  `, 25);

  assert.deepEqual(
    await post(url, "await bot.lookAt({ x: 1, y: 2, z: 0 }); print('ok')"),
    {
    status: 200,
    body: "ok\n",
  });
});

test("dig is natively cancelled on deadline", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 30 });

  const response = await post(url, "await bot.dig({ name: 'test_block' })");

  assert.equal(response.status, 504);
  assert.equal(JSON.parse(response.body).error, "deadline exceeded");
  assert.equal(bot.diggingStopped, true);
  assertClean(bot);
});

test("facade inventory and block awaitables still resolve", async (t) => {
  const { bot, url } = await createFixture(t);

  const response = await post(url, `
    await bot.equip({ name: 'stick' }, 'hand')
    await bot.tossStack({ name: 'dirt' })
    await bot.consume()
    await bot.craft({ name: 'planks' }, 1, null)
    await bot.placeBlock({ name: 'stone' }, { x: 0, y: 1, z: 0 })
    await bot.activateBlock({ name: 'lever' })
    print('done')
  `);

  assert.deepEqual(response, { status: 200, body: "done\n" });
  assert.deepEqual(bot.calls.map((call) => call.name), [
    "equip",
    "tossStack",
    "consume",
    "craft",
    "placeBlock",
    "activateBlock",
  ]);
  assertClean(bot);
});

test("non-cancelable awaitables reject on deadline "
  + "without poisoning later requests", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 30 });
  bot.equip = () => {
    bot.calls.push({ name: "equip" });
    return new Promise(() => {});
  };

  const timedOut = await post(
    url,
    "await bot.equip({ name: 'stick' }, 'hand')",
  );
  assert.equal(timedOut.status, 504);
  assert.equal(JSON.parse(timedOut.body).error, "deadline exceeded");
  assert.deepEqual(bot.calls.map((call) => call.name), ["equip"]);

  const followup = await post(url, "print('after-timeout')");
  assert.deepEqual(followup, { status: 200, body: "after-timeout\n" });
  assertClean(bot);
});

test("many short evals in sequence do not leak state", async (t) => {
  const { bot, url } = await createFixture(t);

  for (let i = 0; i < 75; i++) {
    const response = await post(url, `print('seq', ${i})`);
    assert.deepEqual(response, { status: 200, body: `seq ${i}\n` });
  }

  assertClean(bot);
});

test("near-deadline completions are clean 200s or clean 504s", async (t) => {
  const { bot, url } = await createFixture(t, { defaultTimeoutMs: 25 });

  for (let i = 0; i < 20; i++) {
    const ms = i % 2 === 0 ? 20 : 30;
    const response = await post(url, mutateTemporaryState(`
      await sleep(${ms})
      print('done', ${i})
    `));

    if (response.status === 200) {
      assert.equal(response.body, `done ${i}\n`);
    } else {
      assert.equal(response.status, 504);
      assert.equal(JSON.parse(response.body).error, "deadline exceeded");
    }
    assertClean(bot);
  }
});

test("repeated cleanup after errors does not leak state", async (t) => {
  const { bot, url } = await createFixture(t);

  for (let i = 0; i < 25; i++) {
    const response = await post(
      url,
      mutateTemporaryState(`throw new Error('repeat-${i}')`),
    );
    assert.equal(response.status, 500);
  }

  assertClean(bot);
});

async function createFixture(t, config = {}) {
  const bot = createFakeBot();
  const server = createServer(bot, {
    defaultTimeoutMs: config.defaultTimeoutMs ?? 500,
    snippetsPath: config.snippetsPath,
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  return {
    bot,
    server,
    url: `http://127.0.0.1:${port}/eval`,
    listenUrl: `http://127.0.0.1:${port}/listen`,
  };
}

function createFakeBot() {
  const bot = new EventEmitter();
  bot.setMaxListeners(300);
  bot.controlState = {};
  bot.currentWindow = null;
  bot.usingHeldItem = false;
  bot.diggingStopped = false;
  bot.calls = [];
  bot.username = "mcbot";
  bot.entity = { position: { x: 0, y: 64, z: 0 } };

  bot.setControlState = (state, value) => {
    bot.controlState[state] = Boolean(value);
  };

  const record = (name) => async (...args) => {
    bot.calls.push({ name, args });
  };

  bot.whisper = (...args) => { bot.calls.push({ name: "whisper", args }); };

  bot.equip = record("equip");
  bot.unequip = record("unequip");
  bot.toss = record("toss");
  bot.tossStack = record("tossStack");
  bot.consume = record("consume");
  bot.craft = record("craft");
  bot.placeBlock = record("placeBlock");
  bot.activateBlock = record("activateBlock");
  bot.lookAt = record("lookAt");
  bot.dig = () => new Promise(() => {});
  bot.stopDigging = () => { bot.diggingStopped = true; };

  bot.activateItem = () => { bot.usingHeldItem = true; };
  bot.deactivateItem = () => { bot.usingHeldItem = false; };

  bot.openContainer = async () => {
    const window = { id: 1 };
    bot.currentWindow = window;
    return window;
  };
  bot.openChest = bot.openContainer;
  bot.closeWindow = (window) => {
    if (bot.currentWindow === window) bot.currentWindow = null;
  };

  bot.on("physicTick", () => {});
  return bot;
}

function mutateTemporaryState(tail) {
  return `
    bot.setControlState('jump', true)
    bot.on('physicTick', () => {})
    ${tail}
  `;
}

function assertClean(bot) {
  assert.equal(!!bot.controlState.jump, false);
  assert.equal(bot.listenerCount("physicTick"), 1);
}

async function post(url, body) {
  return request("POST", url, body);
}

async function request(method, url, body) {
  const response = await fetch(url, { method, body });
  return { status: response.status, body: await response.text() };
}

function abandonPost(url, body, destroyAfterMs) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.end(body);
    setTimeout(() => req.destroy(), destroyAfterMs);
  });
}

function observeUnhandledRejection() {
  let cleanup = () => {};
  const promise = new Promise((resolve) => {
    const handler = (reason) => resolve(reason);
    process.on("unhandledRejection", handler);
    cleanup = () => process.off("unhandledRejection", handler);
  });
  return { promise, cleanup };
}

async function readNextLine(reader) {
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream ended before a line arrived");
    buffered += decoder.decode(value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertJsonSubset(json, expected) {
  const actual = JSON.parse(json);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value);
  }
}
