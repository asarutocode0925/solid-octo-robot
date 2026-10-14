import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { MAPS, WEAPONS, WEAPON_ORDER, newPhys, stepMove, resolveBoxes } from "../shared/game.js";

assert.ok(existsSync(new URL("../client/main.js", import.meta.url)), "client/main.js must exist in build context");
assert.ok(existsSync(new URL("../server/index.js", import.meta.url)), "server/index.js must exist");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
assert.match(html, /src=["']\.\/client\/main\.js["']/, "HTML entry point must use a relative Vite-resolvable path");
assert.ok(MAPS.length > 0, "at least one map must exist");
assert.equal(new Set(MAPS.map((m) => m.name)).size, MAPS.length, "map names must be unique");
assert.ok(WEAPON_ORDER.every((key) => WEAPONS[key]), "weapon order must resolve to weapon data");

for (const map of MAPS) {
  assert.ok(Number.isFinite(map.bound) && map.bound > 0, `${map.name}: invalid bounds`);
  for (const box of map.boxes) {
    assert.ok([box.x, box.z, box.w, box.d, box.h].every(Number.isFinite), `${map.name}: invalid box`);
    assert.ok(box.w > 0 && box.d > 0 && box.h > 0, `${map.name}: non-positive box size`);
  }

  // The same grid fallback used by the server must find a free spawn point.
  let found = false;
  for (let x = -map.bound + 1; x < map.bound && !found; x += 2) {
    for (let z = -map.bound + 1; z < map.bound; z += 2) {
      const resolved = resolveBoxes(x, z, map.boxes);
      if (Math.abs(resolved.x - x) < 1e-6 && Math.abs(resolved.z - z) < 1e-6) {
        found = true;
        break;
      }
    }
  }
  assert.ok(found, `${map.name}: no clear spawn cell found`);

  const state = newPhys(0, 0);
  for (let i = 0; i < 200; i++) {
    stepMove(state, { x: i % 2 ? 1 : -1, z: 0.25, j: i % 5 === 0 }, 0.4, 0.05, map);
    assert.ok([state.x, state.y, state.z, state.vx, state.vy, state.vz].every(Number.isFinite), `${map.name}: physics became non-finite`);
    assert.ok(Math.abs(state.x) <= map.bound && Math.abs(state.z) <= map.bound && state.y >= 0, `${map.name}: physics escaped bounds`);
  }
}
console.log(`Smoke tests passed (${MAPS.length} maps, ${WEAPON_ORDER.length} weapons).`);
