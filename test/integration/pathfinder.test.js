// Integration tests for bot.goto / bot.follow.
//
// Skipped unless INTEGRATION_TESTS=1. Run with:
//   INTEGRATION_TESTS=1 node --test test/integration/pathfinder.test.js

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { withWorld } = require("./fixture.js");

const skip = !process.env.INTEGRATION_TESTS;
const opts = { skip, timeout: 240_000 };

// Stone slab `width` x `depth` at y=0; bot stands on top at y=1.
function flatStone(width, depth) {
  return Array.from({ length: depth }, () =>
    Array.from({ length: width }, () => "stone"));
}

describe("goto", () => {
  test("walks a straight path on flat ground", opts, async () => {
    const map = flatStone(5, 1);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        await bot.goto(world(4, 1, 0));
        const p = bot.entity.position;
        print((p.x - ORIGIN.x).toFixed(2), (p.z - ORIGIN.z).toFixed(2));
        print(bot.getControlState("forward"), bot.getControlState("jump"));
      `);
      const [posLine, ctrlLine] = out.trim().split("\n");
      const [x, z] = posLine.split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 4.5, z - 0.5) < 1.0,
        `bot ended at local (${x}, ${z}); expected near (4.5, 0.5)`,
      );
      // All movement controls released after arrival.
      assert.equal(ctrlLine, "false false");
    });
  });

  test("climbs a single step-up", opts, async () => {
    // x=0 single block (stand y=1); x=1 two-tall column (stand y=2).
    const map = [[["stone"], ["stone", "stone"]]];
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        await bot.goto(world(1, 2, 0));
        const p = bot.entity.position;
        print(
          (p.x - ORIGIN.x).toFixed(2),
          (p.y - ORIGIN.y).toFixed(2),
          (p.z - ORIGIN.z).toFixed(2),
        );
      `);
      const [x, y, z] = out.trim().split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 1.5, z - 0.5) < 1.0,
        `bot ended at local (${x}, ${z}); expected near (1.5, 0.5)`,
      );
      assert.ok(
        Math.abs(y - 2) < 0.5,
        `bot ended at y=${y}; expected near 2`,
      );
    });
  });

  test("drops down a step within the limit", opts, async () => {
    // x=0 three-tall column (stand y=3); x=1 single block (stand y=1).
    const map = [[["stone", "stone", "stone"], ["stone"]]];
    await withWorld(map, { x: 0.5, y: 3, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        await bot.goto(world(1, 1, 0));
        const p = bot.entity.position;
        print(
          (p.x - ORIGIN.x).toFixed(2),
          (p.y - ORIGIN.y).toFixed(2),
          (p.z - ORIGIN.z).toFixed(2),
        );
      `);
      const [x, y, z] = out.trim().split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 1.5, z - 0.5) < 1.0,
        `bot ended at local (${x}, ${z}); expected near (1.5, 0.5)`,
      );
      assert.ok(
        Math.abs(y - 1) < 0.5,
        `bot ended at y=${y}; expected near 1`,
      );
    });
  });

  test("throws GotoError(stuck) when a block is placed mid-walk", opts,
    async () => {
      // 6x1 stone corridor; no detour possible. Once the bot leaves spawn,
      // drop a stone wall at x=3 so the next waypoint becomes unstandable.
      const map = flatStone(6, 1);
      await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
        const out = await evalScript(`
          const goalP = bot.goto(world(5, 1, 0));
          while (bot.entity.position.x - ORIGIN.x < 0.8) {
            await sleep(50);
          }
          bot.chat(
            "/setblock " + (ORIGIN.x + 3) + " " + (ORIGIN.y + 1)
              + " " + (ORIGIN.z + 0) + " minecraft:stone",
          );
          try {
            await goalP;
            print("ok");
          } catch (e) {
            print(e.constructor.name, e.status);
          }
          print((bot.entity.position.x - ORIGIN.x).toFixed(2));
          print(bot.getControlState("forward"));
        `);
        const lines = out.trim().split("\n");
        assert.equal(lines[0], "GotoError stuck");
        const x = Number(lines[1]);
        assert.ok(x < 3, `bot stopped at x=${x}; expected before the wall`);
        assert.equal(lines[2], "false");
      });
    });

  test("throws GotoError(unreachable) when no route exists", opts, async () => {
    // 3x3 stone island in an otherwise empty arena. The pathfinder's
    // 3-block step-down limit means no path off the island exists.
    const map = flatStone(3, 3);
    await withWorld(map, { x: 1.5, y: 1, z: 1.5 }, async (evalScript) => {
      const out = await evalScript(`
        try {
          await bot.goto(world(9, 1, 9));
          print("ok");
        } catch (e) {
          print(e.constructor.name, e.status);
        }
      `);
      assert.equal(out.trim(), "GotoError unreachable");
    });
  });

  test("accepts a distance function as the goal", opts, async () => {
    const map = flatStone(5, 1);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        const target = world(4, 1, 0);
        const distFn = ({ x, y, z }) =>
          Math.hypot(x - target.x, y - target.y, z - target.z);
        await bot.goto(distFn);
        const p = bot.entity.position;
        print((p.x - ORIGIN.x).toFixed(2), (p.z - ORIGIN.z).toFixed(2));
      `);
      const [x, z] = out.trim().split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 4.5, z - 0.5) < 1.0,
        `bot ended at local (${x}, ${z}); expected near (4.5, 0.5)`,
      );
    });
  });

  test("throws GotoError(limit) when maxNodes is exceeded", opts, async () => {
    const map = flatStone(10, 10);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        try {
          await bot.goto(world(9, 1, 9), { maxNodes: 2 });
          print("ok");
        } catch (e) {
          print(e.constructor.name, e.status);
        }
      `);
      assert.equal(out.trim(), "GotoError limit");
    });
  });

  test("returns cleanly when stopWhen is true at entry", opts, async () => {
    const map = flatStone(5, 5);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        await bot.goto(world(4, 1, 0), { stopWhen: () => true });
        const p = bot.entity.position;
        print((p.x - ORIGIN.x).toFixed(2), (p.z - ORIGIN.z).toFixed(2));
      `);
      const [x, z] = out.trim().split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 0.5, z - 0.5) < 1.0,
        `bot moved from spawn: ended at (${x}, ${z})`,
      );
    });
  });

  test("returns cleanly when stopWhen becomes true mid-walk", opts,
    async () => {
      const map = flatStone(10, 5);
      await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
        const out = await evalScript(`
          await bot.goto(world(9, 1, 0), {
            stopWhen: () => bot.entity.position.x - ORIGIN.x > 3,
          });
          const p = bot.entity.position;
          print((p.x - ORIGIN.x).toFixed(2));
          print(bot.getControlState("forward"), bot.getControlState("jump"));
        `);
        const [posLine, ctrlLine] = out.trim().split("\n");
        const x = Number(posLine);
        assert.ok(x > 3, `bot stopped early at x=${x}`);
        assert.ok(
          x < 9,
          `bot reached the goal at x=${x}; expected stop mid-walk`,
        );
        assert.equal(ctrlLine, "false false");
      });
    });

  test("rejects on bad arguments", opts, async () => {
    const map = flatStone(1, 1);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        const names = [];
        try { await bot.goto(null); names.push("none"); }
        catch (e) { names.push(e.constructor.name); }
        try { await bot.goto({ x: "oops", y: 1, z: 0 }); names.push("none"); }
        catch (e) { names.push(e.constructor.name); }
        print(names.join(" "));
      `);
      assert.equal(out.trim(), "TypeError TypeError");
    });
  });
});

describe("follow", () => {
  test("returns when stopWhen is true at entry", opts, async () => {
    const map = flatStone(5, 5);
    await withWorld(map, { x: 0.5, y: 1, z: 0.5 }, async (evalScript) => {
      const out = await evalScript(`
        const target = world(4, 1, 0);
        const distFn = ({ x, y, z }) =>
          Math.hypot(x - target.x, y - target.y, z - target.z);
        await bot.follow(distFn, { stopWhen: () => true });
        const p = bot.entity.position;
        print((p.x - ORIGIN.x).toFixed(2), (p.z - ORIGIN.z).toFixed(2));
      `);
      const [x, z] = out.trim().split(/\s+/).map(Number);
      assert.ok(
        Math.hypot(x - 0.5, z - 0.5) < 1.0,
        `bot moved from spawn: ended at (${x}, ${z})`,
      );
    });
  });
});
