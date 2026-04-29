// A* pathfinding building blocks.
//
// Top-down: a Minecraft-aware `goto` orchestrator drives the bot through a
// path produced by a generic `astar` search backed by a binary min-heap.

const Vec3 = require("vec3").Vec3;

// ---------------------------------------------------------------------------
// Bot pathfinding

// Block names whose feet-cell occupancy would damage or trap the bot.
const HAZARDS = new Set(["lava", "fire", "cactus", "magma_block"]);

// Cost of a diagonal (two-axis) move on the horizontal plane. Cardinal moves
// cost 1, so this matches Euclidean step length and keeps the search metric
// consistent with the octile heuristic below.
const DIAGONAL_COST = Math.SQRT2;

// Plan and walk the bot to `goal`. The goal may be either:
//   - an `{x, y, z}` block position, or
//   - a distance function `({x, y, z}) => number` returning the distance
//     from a candidate block to the target. Any block whose distance is
//     <= 0.5 is treated as arrived.
//
// Resolves with `undefined` on arrival, or early when the `stopWhen`
// predicate (checked at entry, between waypoints, and each tick) returns
// true.
//
// Throws:
//   GotoError       failure to reach the goal:
//                     status "unreachable" — A* drained the open set
//                     status "limit"       — A* hit the maxNodes budget
//                     status "stuck"       — walker stalled mid-route
//   TypeError       programmer error (bad bot or goal arguments)
async function goto(bot, goal, options = {}) {
  if (!bot || !bot.entity || !bot.entity.position) {
    throw new TypeError("goto: bot.entity.position required");
  }
  const distanceTo = toDistanceFn(goal);

  const { maxNodes = 10000, stopWhen = () => false } = options;
  if (stopWhen()) return;

  const start = floorPos(bot.entity.position);
  const plan = planPath(bot, start, distanceTo, { maxNodes });

  if (plan.status === "limit" || plan.status === "exhausted") {
    const status = plan.status === "limit" ? "limit" : "unreachable";
    throw new GotoError({
      status,
      closest: plan.closest,
      distance: distanceTo(plan.closest),
    });
  }

  try {
    await walkPath(bot, plan.path, { stopWhen });
  } catch (error) {
    // walkPath throws a bare GotoError({status: "stuck"}); enrich it here
    // where we have the bot's live position and the distance function.
    if (error instanceof GotoError && error.status === "stuck") {
      const closest = floorPos(bot.entity.position);
      throw new GotoError({
        status: "stuck",
        closest,
        distance: distanceTo(closest),
      });
    }
    throw error;
  } finally {
    clearMovementControls(bot);
  }
}

// Error thrown by `goto` when the bot fails to reach the goal.
//   status:   "unreachable" | "limit" | "stuck"
//   closest:  block coordinate the bot got nearest to the goal (closest
//             expanded A* node for planning failures, bot's stopped
//             position for stuck)
//   distance: closest's distance to the goal
class GotoError extends Error {
  constructor({ status, closest, distance }) {
    let detail = status;
    if (distance !== undefined) detail += `, ${distance.toFixed(2)} away`;
    super(`goto: ${detail}`);
    this.name = "GotoError";
    this.status = status;
    if (closest !== undefined) this.closest = closest;
    if (distance !== undefined) this.distance = distance;
  }
}

// Follow a moving target. `target` is either:
//   - an entity (any object with a `.position` Vec3); the bot stays within
//     `range` blocks of it (default 5).
//   - a `(pos) => distance` function (same form as goto's distance-function
//     goal); bake any stand-off distance into the function. `range` is
//     ignored in this case.
//
// Loops until `stopWhen` returns true (default: forever). Each iteration
// walks toward the current target, interrupting goto every replan interval
// (scaled by distance). Retries silently on stuck/unreachable/limit.
async function follow(bot, target, options = {}) {
  const { range = 5, stopWhen = () => false } = options;
  const distanceFn = typeof target === "function"
    ? target
    : (pos) => target.position.distanceTo(pos) - range;

  while (!stopWhen()) {
    const here = floorPos(bot.entity.position);
    const dist = Math.max(0, distanceFn(here));
    // 50ms per tick. Replan interval scales with distance (min 1s = 20 ticks).
    const replanMs = Math.max(Math.ceil(dist), 20) * 50;
    const deadline = Date.now() + replanMs;
    const stopOrReplan = () => stopWhen() || Date.now() >= deadline;

    try {
      await goto(bot, distanceFn, { stopWhen: stopOrReplan });
    } catch (error) {
      if (!(error instanceof GotoError)) throw error;
      // stuck/unreachable/limit: target may move into reach later.
    }
    // Idle until the deadline; on deadline-triggered replan this is already
    // true and we re-plan immediately.
    while (!stopOrReplan()) {
      await bot.waitForTicks(1);
    }
  }
}

// Plan a path from a start block to a goal via astar. `goal` may be an
// `{x, y, z}` point or a `(pos) => distance` function (see `goto`).
function planPath(bot, start, goal, { maxNodes } = {}) {
  const distanceTo = toDistanceFn(goal);
  return astar({
    start,
    isGoal: (n) => distanceTo(n) <= 0.5,
    neighbors: (n) => worldNeighbors(bot, n),
    // Each grid move costs at least 1, so subtracting the 0.5 arrival
    // tolerance keeps the heuristic admissible without being slack.
    heuristic: (n) => Math.max(0, distanceTo(n) - 0.5),
    key: positionKey,
    maxNodes,
  });
}

// Coerce a goal argument into a `(pos) => distance` function. Accepts an
// existing distance function as-is, or an `{x, y, z}` point which becomes
// Euclidean distance to that block.
function toDistanceFn(goal) {
  if (typeof goal === "function") return goal;
  if (goal
    && Number.isFinite(goal.x)
    && Number.isFinite(goal.y)
    && Number.isFinite(goal.z)) {
    const { x: gx, y: gy, z: gz } = goal;
    return ({ x, y, z }) => Math.hypot(x - gx, y - gy, z - gz);
  }
  throw new TypeError(
    "goal must be {x,y,z} or a (pos) => distance function",
  );
}

// Drive the bot through a list of standing positions in order. Throws a
// GotoError({status: "stuck"}) if the bot stalls; otherwise returns once
// the final waypoint is reached or `stopWhen` becomes true.
async function walkPath(bot, path, { stopWhen = () => false } = {}) {
  for (let i = 1; i < path.length; i++) {
    if (stopWhen()) return;
    await walkToWaypoint(bot, path[i], { stopWhen });
  }
}

// Drive the bot to a single standing position, ticking until arrival.
// Returns early when `stopWhen` becomes true. Throws a
// GotoError({status: "stuck"}) if the waypoint becomes unstandable or the
// bot makes no progress for `stuckLimit` ticks.
async function walkToWaypoint(bot, target, { stopWhen = () => false } = {}) {
  const stuckLimit = 40;
  let bestDistance = Infinity;
  let stuckTicks = 0;

  while (true) {
    if (stopWhen()) return;

    // Re-validate the waypoint each tick so we notice world changes.
    if (!isStandable(bot, target.x, target.y, target.z)) {
      throw new GotoError({ status: "stuck" });
    }
    const tx = target.x + 0.5;
    const tz = target.z + 0.5;
    const pos = bot.entity.position;
    // Horizontal-only distance: gravity and the jump key handle y, so chasing
    // vertical alignment would just keep us steering at a waypoint we've
    // already passed in X/Z (which whips lookAt around mid-fall).
    const dist = Math.hypot(tx - pos.x, tz - pos.z);

    // Vertical check too: on a step-down the bot crosses the horizontal
    // cutoff while still partly supported by the higher block.
    if (dist < 0.3 && Math.abs(pos.y - target.y) < 0.5) return;

    if (dist < bestDistance - 0.01) {
      bestDistance = dist;
      stuckTicks = 0;
    } else if (++stuckTicks > stuckLimit) {
      throw new GotoError({ status: "stuck" });
    }

    // Only yaw affects horizontal motion in mineflayer; keep pitch level so
    // the head doesn't dive at step-down waypoints. Mineflayer convention:
    // yaw=0 faces -z, increasing counter-clockwise viewed from above.
    const yaw = Math.atan2(pos.x - tx, pos.z - tz);
    await bot.look(yaw, 0, true);

    bot.setControlState("forward", true);
    bot.setControlState("jump", target.y > Math.floor(pos.y));

    await bot.waitForTicks(1);
  }
}

// Yield 4-cardinal neighbors with same-level walks, step-up 1, and step-down
// 3, plus 4 diagonal same-level neighbors at sqrt(2) cost.
function* worldNeighbors(bot, p) {
  const cardinals = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of cardinals) {
    const nx = p.x + dx;
    const nz = p.z + dz;

    if (isStandable(bot, nx, p.y, nz)) {
      yield { node: { x: nx, y: p.y, z: nz }, cost: 1 };
      continue;
    }
    if (canStepUp(bot, p, nx, nz)) {
      yield { node: { x: nx, y: p.y + 1, z: nz }, cost: 1 };
      continue;
    }
    yield* stepDownNeighbors(bot, p, nx, nz);
  }

  const diagonals = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dx, dz] of diagonals) {
    if (canStepDiagonal(bot, p, dx, dz)) {
      yield {
        node: { x: p.x + dx, y: p.y, z: p.z + dz },
        cost: DIAGONAL_COST,
      };
    }
  }
}

// True iff the bot can walk diagonally from p to (p.x+dx, p.y, p.z+dz).
//
// Diagonals are restricted to the same y-level: blending step-up or step-down
// with a corner move would require modeling sub-step collisions the walker
// can't honor. Both flanking cardinal cells must also have body clearance so
// the bot does not clip a wall corner mid-step.
function canStepDiagonal(bot, p, dx, dz) {
  const nx = p.x + dx;
  const nz = p.z + dz;
  if (!isStandable(bot, nx, p.y, nz)) return false;
  if (!isBodyClear(bot, p.x + dx, p.y, p.z)) return false;
  if (!isBodyClear(bot, p.x, p.y, p.z + dz)) return false;
  return true;
}

// True iff the two-block-tall column at (x, y..y+1, z) is passable.
function isBodyClear(bot, x, y, z) {
  if (!isPassable(bot, x, y, z)) return false;
  if (!isPassable(bot, x, y + 1, z)) return false;
  return true;
}

// True iff the bot can step up by one block onto (nx, p.y+1, nz).
function canStepUp(bot, p, nx, nz) {
  // Ceiling above current head must be empty for the rising body.
  if (!isPassable(bot, p.x, p.y + 2, p.z)) return false;
  // The block we step onto becomes the new floor; it must be a full cube.
  if (!isFullySolid(bot, nx, p.y, nz)) return false;
  // New feet and head positions must be clear.
  if (!isBodyClear(bot, nx, p.y + 1, nz)) return false;
  return true;
}

// Yield any step-down landing reachable by walking off the edge.
function* stepDownNeighbors(bot, p, nx, nz) {
  // The horizontal cell the bot walks into must have empty feet and head.
  if (!isBodyClear(bot, nx, p.y, nz)) return;

  for (let drop = 1; drop <= 3; drop++) {
    const ny = p.y - drop;
    if (isStandable(bot, nx, ny, nz)) {
      yield { node: { x: nx, y: ny, z: nz }, cost: 1 };
      return;
    }
  }
}

// True iff the bot can stand at (x, y, z): clear feet+head and a solid floor.
function isStandable(bot, x, y, z) {
  if (!isBodyClear(bot, x, y, z)) return false;
  if (!isFullySolid(bot, x, y - 1, z)) return false;
  return true;
}

// True iff the bot can occupy a single block-shaped cell without harm.
function isPassable(bot, x, y, z) {
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) return false;
  if (block.boundingBox !== "empty") return false;
  if (HAZARDS.has(block.name)) return false;
  return true;
}

// True iff the block at (x, y, z) is a full-cube collider.
function isFullySolid(bot, x, y, z) {
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) return false;
  return block.boundingBox === "block";
}

// Stringify a position for use as an astar node key.
function positionKey(p) {
  return `${p.x},${p.y},${p.z}`;
}

// Floor a fractional position to integer block coordinates.
function floorPos(p) {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

// Clear movement controls the walker may have left engaged.
function clearMovementControls(bot) {
  bot.setControlState("forward", false);
  bot.setControlState("jump", false);
  bot.setControlState("sprint", false);
}

// ---------------------------------------------------------------------------
// A* search

// Search for a least-cost path from `start` to any node satisfying `isGoal`.
//
// Required options:
//   start                          any value identifying the start node
//   isGoal:    (node) => boolean   true when a node is an acceptable goal
//   neighbors: (node) => Iterable<{ node, cost }>   cost must be >= 0
//   heuristic: (node) => number    admissible (never overestimates) for
//                                  optimality; non-negative
//
// Optional options:
//   key:      (node) => string|number   identity by default; used to dedupe
//                                       nodes whose values are not primitive
//   maxNodes: number                    expansion budget (default 10000)
//
// Returns { status, path, cost, stats, closest? } where status is one of:
//   "found"      goal reached; path is [start, ..., goal], cost is total g
//   "exhausted"  open set drained without reaching a goal
//   "limit"      maxNodes expansions used without reaching a goal
// For non-"found" results, `closest` is the expanded node with the smallest
// heuristic value (i.e. the best lower bound on "how close we got").
//
// Negative edge costs and inadmissible heuristics are caller contract
// violations: A* will return a path but it may not be optimal.
function astar(options) {
  const {
    start,
    isGoal,
    neighbors,
    heuristic,
    key = (node) => node,
    maxNodes = 10000,
  } = options;

  const state = createSearchState(start, key, heuristic);

  if (isGoal(start)) {
    return formatResult("found", state, state.startKey);
  }

  while (state.open.size > 0) {
    if (state.stats.expanded >= maxNodes) {
      return formatResult("limit", state, null);
    }

    const current = state.open.pop();
    // Lazy deletion: if a cheaper path to this node was found after the entry
    // was pushed, the heap still holds the stale entry. Skip it.
    if (current.g !== state.gScore.get(current.key)) continue;

    state.stats.expanded++;
    if (current.h < state.closestH) {
      state.closest = current.node;
      state.closestH = current.h;
    }

    if (isGoal(current.node)) {
      return formatResult("found", state, current.key);
    }

    expandNode(state, current, neighbors, heuristic, key);
  }

  return formatResult("exhausted", state, null);
}

// Initialize all per-search structures with the start node already enqueued.
function createSearchState(start, key, heuristic) {
  // Tie-break on h so among equal-f nodes we prefer ones closer to the goal.
  const open = createMinHeap((a, b) => a.f - b.f || a.h - b.h);
  const gScore = new Map();
  const cameFrom = new Map();
  const nodes = new Map();
  const stats = { expanded: 0, generated: 0, maxOpen: 0 };

  const startKey = key(start);
  const startH = heuristic(start);
  gScore.set(startKey, 0);
  nodes.set(startKey, start);
  open.push({ node: start, key: startKey, g: 0, h: startH, f: startH });
  stats.maxOpen = 1;

  return {
    open, gScore, cameFrom, nodes, stats, startKey,
    // Track the expanded node with the smallest heuristic value so failed
    // searches can report "closest we got" without a second pass.
    closest: start,
    closestH: startH,
  };
}

// Relax edges out of `current`, pushing improved successors onto the heap.
function expandNode(state, current, neighbors, heuristic, key) {
  for (const edge of neighbors(current.node)) {
    state.stats.generated++;
    const neighborKey = key(edge.node);
    const tentativeG = current.g + edge.cost;
    const knownG = state.gScore.get(neighborKey);
    if (knownG !== undefined && tentativeG >= knownG) continue;

    state.gScore.set(neighborKey, tentativeG);
    state.nodes.set(neighborKey, edge.node);
    state.cameFrom.set(neighborKey, current.key);
    const h = heuristic(edge.node);
    state.open.push({
      node: edge.node,
      key: neighborKey,
      g: tentativeG,
      h,
      f: tentativeG + h,
    });
    if (state.open.size > state.stats.maxOpen) {
      state.stats.maxOpen = state.open.size;
    }
  }
}

// Build the public result object for a finished search.
function formatResult(status, state, goalKey) {
  if (status !== "found") {
    return {
      status,
      path: null,
      cost: null,
      stats: { ...state.stats },
      closest: state.closest,
    };
  }
  return {
    status,
    path: reconstructPath(state, goalKey),
    cost: state.gScore.get(goalKey),
    stats: { ...state.stats },
  };
}

// Walk parent pointers from the goal back to the start and reverse.
function reconstructPath(state, goalKey) {
  const path = [];
  let cursor = goalKey;
  while (cursor !== undefined) {
    path.push(state.nodes.get(cursor));
    cursor = state.cameFrom.get(cursor);
  }
  path.reverse();
  return path;
}

// ---------------------------------------------------------------------------
// Min-heap

// Create a binary min-heap ordered by a comparator.
//
// `compare(a, b)` follows Array#sort conventions: a negative result means
// `a` comes out first. The default comparator orders numbers ascending.
//
// API:
//   heap.push(item)   - insert one item
//   heap.pop()        - remove and return the smallest item, or undefined
//   heap.peek()       - return the smallest item without removing it
//   heap.size         - current item count (read-only)
//
// Equal-keyed items pop in an unspecified order; the heap is not stable.
function createMinHeap(compare = (a, b) => a - b) {
  const data = [];

  const heap = {
    push(item) {
      data.push(item);
      siftUp(data, compare, data.length - 1);
    },

    pop() {
      if (data.length === 0) return undefined;
      const top = data[0];
      const last = data.pop();
      if (data.length > 0) {
        data[0] = last;
        siftDown(data, compare, 0);
      }
      return top;
    },

    peek() {
      return data.length === 0 ? undefined : data[0];
    },
  };

  Object.defineProperty(heap, "size", {
    get: () => data.length,
    enumerable: true,
  });

  return heap;
}

// Restore the heap property by moving an item upward toward the root.
function siftUp(data, compare, index) {
  const item = data[index];
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compare(item, data[parent]) >= 0) break;
    data[index] = data[parent];
    index = parent;
  }
  data[index] = item;
}

// Restore the heap property by moving an item downward toward the leaves.
function siftDown(data, compare, index) {
  const item = data[index];
  const half = data.length >> 1;
  while (index < half) {
    let child = 2 * index + 1;
    const right = child + 1;
    if (right < data.length && compare(data[right], data[child]) < 0) {
      child = right;
    }
    if (compare(data[child], item) >= 0) break;
    data[index] = data[child];
    index = child;
  }
  data[index] = item;
}

// ---------------------------------------------------------------------------

module.exports = {
  goto,
  follow,
  GotoError,
  planPath,
  astar,
  createMinHeap,
};
