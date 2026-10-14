import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import {
  MAPS, WEAPONS, WEAPON_ORDER, TICK, HIT_R, MAX_HP, EYE_H, RESPAWN_MS,
  newPhys, stepMove, resolveBoxes, rayBoxT, blocked, inMeleeCone, normAngle,
} from "../shared/game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 設定 ----
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";   // fly secrets set ADMIN_KEY=... で設定
const MAX_PLAYERS = 16;
const MAX_PER_IP = 4;
const MAX_MSG_BYTES = 1e4;
const MAX_MSG_PER_SEC = 40;
const VIOLATION_LIMIT = 30;
// 処分の段階：1回1時間 → 2回2時間 → 3回5時間 → 4回10時間 → 5回で永久BAN
const BAN_HOURS = [1, 2, 5, 10];
const PERM_BAN_AT = BAN_HOURS.length + 1;
const penalties = new Map();     // ip -> 処分の回数（メモリ上・再起動で消える）
const MAP_ROTATE_MS = 3 * 60000;
const MAX_NAME = 12;
const STREAK_LEVELS = [3, 5, 7, 10];

// ---- エイムボット検知（疑わしさのスコアを積み、閾値で管理者に通知・自動切断）----
const SNAP_WINDOW_MS = 150;   // この時間内の視点の動きを見る
const SNAP_RAD = 2.2;         // これ以上の一瞬の振り向きは疑わしい（約126度）
const ACC_WINDOW = 40;        // 命中率を見る発射数
const SUS_NOTIFY = 10;        // 管理者に通知する閾値
const SUS_KICK = 25;          // 自動で切断する閾値
const TICK_MS = TICK * 1000;

// ---- ユーティリティ ----
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const sanitizeName = (v) => {
  const s = String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME);
  return s || "ロボット";
};
function isAdminKey(key) {
  if (!ADMIN_KEY || typeof key !== "string") return false;
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- HTTP ----
const app = express();
app.set("trust proxy", true);
app.get("/healthz", (_req, res) => res.send("ok"));
app.use(express.static(path.join(__dirname, "../dist"), { maxAge: "1h" }));

const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" }, maxHttpBufferSize: MAX_MSG_BYTES });

// ---- 状態 ----
let mapIdx = 0;
const map = () => MAPS[mapIdx];
const players = new Map();        // socket.id -> player
const respawnTimers = new Map();  // socket.id -> timeout
const ipCount = new Map();
const bans = new Map();
const adminLog = [];

const clientIp = (socket) =>
  socket.handshake.headers["fly-client-ip"] ||
  String(socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  socket.handshake.address;

const currentW = (p) => WEAPONS[WEAPON_ORDER[p.weapon]];
const weaponKeyOf = (w) => WEAPON_ORDER.find((k) => WEAPONS[k] === w);

function recordAdminAction(by, action, target = "") {
  adminLog.push({ t: Date.now(), by, action, target });
  if (adminLog.length > 50) adminLog.shift();
  console.log(`[admin] ${by}: ${action} ${target}`);
  for (const [id, q] of players) {
    if (q.admin) io.to(id).emit("adminlog", adminLog.slice(-20));
  }
}

// 接続時のチェック（BAN・同一IP上限・満員）
io.use((socket, next) => {
  const ip = clientIp(socket);
  const until = bans.get(ip);
  if (until && until > Date.now()) return next(new Error("banned"));
  if ((ipCount.get(ip) || 0) >= MAX_PER_IP) return next(new Error("too many connections"));
  if (players.size >= MAX_PLAYERS) return next(new Error("full"));
  socket.data.ip = ip;
  next();
});

// 段階的な処分：1時間→2時間→5時間→10時間→永久BAN
function penalize(socket, p, reason) {
  const n = (penalties.get(p.ip) || 0) + 1;
  penalties.set(p.ip, n);
  const permanent = n >= PERM_BAN_AT;
  const hours = permanent ? 0 : BAN_HOURS[n - 1];
  bans.set(p.ip, permanent ? Infinity : Date.now() + hours * 3600000);
  recordAdminAction("自動処分", reason, `${p.name}（${n}回目・${permanent ? "永久BAN" : hours + "時間BAN"}）`);
  socket.disconnect(true);
}

function flag(socket, p, reason) {
  p.violations++;
  console.warn(`violation ${socket.id} (${reason}) x${p.violations}`);
  if (p.violations >= VIOLATION_LIMIT) {
    p.violations = 0;
    penalize(socket, p, "不正な操作の繰り返し");
  }
}

// ---- プレイヤー ----
function spawn(p) {
  const m = map();
  let placed = false;
  for (let i = 0; i < 50 && !placed; i++) {
    const x = (Math.random() * 2 - 1) * m.bound * 0.8;
    const z = (Math.random() * 2 - 1) * m.bound * 0.8;
    const r = resolveBoxes(x, z, m.boxes);
    if (Math.abs(r.x - x) < 1e-6 && Math.abs(r.z - z) < 1e-6) {
      p.s = newPhys(x, z);
      placed = true;
    }
  }
  // Deterministic fallback: never spawn inside a central obstacle if random
  // samples happen to fail (e.g. after adding a denser map).
  if (!placed) {
    for (let x = -m.bound + 1; x < m.bound && !placed; x += 2) {
      for (let z = -m.bound + 1; z < m.bound; z += 2) {
        const r = resolveBoxes(x, z, m.boxes);
        if (Math.abs(r.x - x) < 1e-6 && Math.abs(r.z - z) < 1e-6) {
          p.s = newPhys(x, z);
          placed = true;
          break;
        }
      }
    }
  }
  // The current maps always have clear cells; keep a safe final fallback.
  if (!placed) p.s = newPhys(-m.bound + 1, -m.bound + 1);
  p.hp = MAX_HP;
  p.alive = true;
  p.reloadUntil = 0;
  p.ammos = WEAPON_ORDER.map((k) => WEAPONS[k].mag);
  p.streak = 0;
}

function startReload(p) {
  const w = currentW(p);
  if (!w.melee && !p.reloadUntil && p.ammos[p.weapon] < w.mag) {
    p.reloadUntil = Date.now() + w.reload;
  }
}

function broadcastRoster() {
  const roster = {};
  for (const [id, p] of players) roster[id] = { n: p.name, a: p.admin };
  io.emit("roster", roster);
}

function clearRespawn(id) {
  clearTimeout(respawnTimers.get(id));
  respawnTimers.delete(id);
}

// ---- 攻撃 ----
function damage(attackerSocket, tid, dmg, attacker, w, head = false) {
  const o = players.get(tid);
  if (!o || !o.alive) return;
  attackerSocket.emit("hitmark", { head: !!head });
  o.hp -= dmg;
  if (o.hp > 0) return;

  o.alive = false;
  o.hp = 0;
  o.deaths++;
  attacker.kills++;
  attacker.streak = (attacker.streak || 0) + 1;
  o.streak = 0;
  if (STREAK_LEVELS.includes(attacker.streak)) {
    attackerSocket.emit("streak", { n: attacker.streak });
  }

  io.emit("kill", {
    ki: attackerSocket.id,
    vi: tid,
    k: { n: attacker.name, a: attacker.admin },
    v: { n: o.name, a: o.admin },
    w: w.label,
    h: !!head,
  });
  io.to(tid).emit("died");

  // 一定時間後に復活（乱闘）
  clearRespawn(tid);
  respawnTimers.set(tid, setTimeout(() => {
    respawnTimers.delete(tid);
    if (players.get(tid) === o) spawn(o);
  }, RESPAWN_MS));
}

// 近接攻撃：扇形・遮蔽物の向こうは不可・背後からは大ダメージ
function meleeAttack(socket, p, w) {
  const m = map();
  let hitId = null;
  let bestD = Infinity;
  for (const [oid, o] of players) {
    if (oid === socket.id || !o.alive) continue;
    if (!inMeleeCone(p.s.x, p.s.z, p.yaw, o.s.x, o.s.z, w.range, w.cone)) continue;
    if (blocked(p.s.x, p.s.z, o.s.x, o.s.z, m.boxes)) continue;
    const d = Math.hypot(o.s.x - p.s.x, o.s.z - p.s.z);
    if (d < bestD) {
      bestD = d;
      hitId = oid;
    }
  }
  if (!hitId) return;
  const victim = players.get(hitId);
  const dx = p.s.x - victim.s.x;
  const dz = p.s.z - victim.s.z;
  const dist = Math.max(1e-6, Math.hypot(dx, dz));
  // Forward vector follows the same yaw convention used by movement/shooting.
  const facingDot = (dx / dist) * -Math.sin(victim.yaw) + (dz / dist) * -Math.cos(victim.yaw);
  const back = facingDot < -0.5;
  damage(socket, hitId, back ? w.backstab : w.damage, p, w);
}

// 銃：各弾を独立に判定（遮蔽物・射程・横ずれ・高さでヘッドショット）
function gunFire(socket, p, w) {
  const m = map();
  const dmg = new Map();
  const headMap = new Map();
  const tanP = Math.tan(p.pitch);
  for (let i = 0; i < w.pellets; i++) {
    const a = p.yaw + (Math.random() * 2 - 1) * w.spread;
    const dx = -Math.sin(a);
    const dz = -Math.cos(a);

    let wallT = w.range;
    for (const b of m.boxes) {
      const t = rayBoxT(p.s.x, p.s.z, dx, dz, b);
      if (t >= 0 && t < wallT) wallT = t;
    }

    let best = wallT;
    let hitId = null;
    let headNow = false;
    for (const [oid, o] of players) {
      if (oid === socket.id || !o.alive) continue;
      const ox = o.s.x - p.s.x;
      const oz = o.s.z - p.s.z;
      const t = ox * dx + oz * dz;
      if (t < 0 || t > best) continue;
      if (Math.abs(ox * dz - oz * dx) >= HIT_R) continue;
      const yAt = p.s.y + EYE_H + tanP * t - o.s.y;
      if (yAt < 0 || yAt > 2.2) continue;
      best = t;
      hitId = oid;
      headNow = yAt >= 1.65;
    }
    if (hitId) {
      const mul = headNow ? (w.head ?? 2) : 1;
      dmg.set(hitId, (dmg.get(hitId) || 0) + w.damage * mul);
      if (headNow) headMap.set(hitId, true);
    }
  }
  for (const [tid, d] of dmg) damage(socket, tid, d, p, w, headMap.has(tid));
  return { hit: dmg.size > 0, head: headMap.size > 0, single: w.pellets === 1 };
}

// 視点の履歴（直近の動き）
function pushYaw(p, yaw) {
  const now = Date.now();
  p.yawHist.push({ t: now, yaw });
  while (p.yawHist.length && now - p.yawHist[0].t > SNAP_WINDOW_MS) p.yawHist.shift();
}

// 直近の時間内に視点がどれだけ大きく動いたか（ラジアン）
function swingIn(p, ms) {
  const now = Date.now();
  let min = Infinity;
  let max = -Infinity;
  for (const e of p.yawHist) {
    if (now - e.t > ms) continue;
    if (e.yaw < min) min = e.yaw;
    if (e.yaw > max) max = e.yaw;
  }
  return max >= min ? max - min : 0;
}

function addSuspicion(p, amount, reason) {
  p.sus += amount;
  if (p.sus >= SUS_NOTIFY && p.sus >= p.lastSusLog + 5) {
    p.lastSusLog = p.sus;
    recordAdminAction("自動検知", reason, `${p.name}（疑い ${Math.round(p.sus)}）`);
  }
  return p.sus >= SUS_KICK;
}

// 射撃ごとの判定：スナップと、単発武器の異常な命中率
function judgeShot(socket, p, res) {
  let kick = false;
  if (res.hit && swingIn(p, SNAP_WINDOW_MS) >= SNAP_RAD) {
    kick = addSuspicion(p, 2, "視点のスナップ") || kick;
  }
  if (res.single) {
    p.shots.push(res);
    if (p.shots.length >= ACC_WINDOW) {
      const hits = p.shots.filter((s) => s.hit).length;
      const heads = p.shots.filter((s) => s.head).length;
      if (hits / ACC_WINDOW >= 0.85 && heads / Math.max(1, hits) >= 0.6) {
        kick = addSuspicion(p, 3, "命中率が異常") || kick;
      }
      p.shots = [];
    }
  }
  // 管理者は誤検知の確認用に、自動処分の対象外
  if (kick && !p.admin) penalize(socket, p, "エイムボットの疑い");
}

function fire(socket, p, yaw, pitch) {
  const now = Date.now();
  const w = currentW(p);
  if (!p.alive || p.reloadUntil) return;
  if (now - p.lastShot < w.cooldown) return;
  if (!w.melee && p.ammos[p.weapon] <= 0) {
    startReload(p);
    return;
  }
  p.lastShot = now;
  p.yaw = yaw;
  p.pitch = pitch;
  if (w.melee) {
    meleeAttack(socket, p, w);
  } else {
    p.ammos[p.weapon]--;
    judgeShot(socket, p, gunFire(socket, p, w));
  }
}

// 管理者用：相手の横へ配置
function placeNear(q, x, z) {
  const m = map();
  const nx = clamp(x + 1.5, -m.bound, m.bound);
  const r = resolveBoxes(nx, z, m.boxes);
  q.s.x = r.x;
  q.s.z = r.z;
  q.s.vx = 0;
  q.s.vz = 0;
}

// マップ切り替え（全員を配置し直す）
function setMap(i) {
  mapIdx = i;
  for (const t of respawnTimers.values()) clearTimeout(t);
  respawnTimers.clear();
  for (const p of players.values()) spawn(p);
  io.emit("map", { i: mapIdx });
}

// ---- 接続 ----
io.on("connection", (socket) => {
  const ip = socket.data.ip;
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

  const p = {
    ip,
    name: "ロボット",
    admin: false,
    s: null,
    yaw: 0,
    pitch: 0,
    input: { x: 0, z: 0, j: false },
    hp: MAX_HP, alive: true, kills: 0, deaths: 0,
    weapon: 1, ammos: [], reloadUntil: 0,
    lastShot: 0, msgWindowStart: Date.now(), msgCount: 0,
    violations: 0, streak: 0,
    yawHist: [], shots: [], sus: 0, lastSusLog: 0,
  };
  spawn(p);
  players.set(socket.id, p);
  console.log(`join ${socket.id} (${players.size}/${MAX_PLAYERS})`);

  socket.emit("map", { i: mapIdx });
  broadcastRoster();

  const rateOk = () => {
    const now = Date.now();
    if (now - p.msgWindowStart > 1000) {
      p.msgWindowStart = now;
      p.msgCount = 0;
    }
    p.msgCount++;
    if (p.msgCount > MAX_MSG_PER_SEC) {
      flag(socket, p, "rate");
      return false;
    }
    return true;
  };

  socket.on("join", (data) => {
    if (!rateOk() || !data || typeof data !== "object") return;
    p.name = sanitizeName(data.name);
    p.admin = isAdminKey(data.key);
    broadcastRoster();
    if (p.admin) socket.emit("adminlog", adminLog.slice(-20));
  });

  socket.on("input", (data) => {
    if (!rateOk()) return;
    if (!data || typeof data !== "object") return flag(socket, p, "input-type");
    if (!fin(data.x) || !fin(data.z) || !fin(data.yaw)) return flag(socket, p, "input-nan");
    p.input = { x: clamp(data.x, -1, 1), z: clamp(data.z, -1, 1), j: data.j === true };
    p.yaw = data.yaw;
    pushYaw(p, data.yaw);
  });

  socket.on("shoot", (data) => {
    if (!rateOk()) return;
    if (!data || !fin(data.yaw)) return flag(socket, p, "shoot-type");
    const pitch = fin(data.pitch) ? clamp(data.pitch, -1.4, 1.4) : 0;
    fire(socket, p, data.yaw, pitch);
  });

  socket.on("switch", (data) => {
    if (!rateOk()) return;
    const i = Number(data?.i);
    if (!Number.isInteger(i) || i < 0 || i >= WEAPON_ORDER.length) return flag(socket, p, "switch");
    if (i === p.weapon) return;
    p.weapon = i;
    p.reloadUntil = 0;
  });

  socket.on("reload", () => {
    if (!rateOk()) return;
    if (p.alive) startReload(p);
  });

  // ---- 管理者操作（すべて p.admin を確認）----
  const adminOnly = () => rateOk() && p.admin;
  const targetOf = (data) => {
    const id = typeof data?.id === "string" ? data.id : "";
    const t = players.get(id);
    return t ? { id, q: t } : null;
  };

  socket.on("admin:kick", (data) => {
    if (!adminOnly()) return;
    const id = typeof data?.id === "string" ? data.id : "";
    const target = io.sockets.sockets.get(id);
    if (!target || target.id === socket.id) return;
    recordAdminAction(p.name, "キック", players.get(id)?.name ?? "");
    target.disconnect(true);
  });

  socket.on("admin:map", (data) => {
    if (!adminOnly()) return;
    const i = Number(data?.i);
    if (!Number.isInteger(i) || i < 0 || i >= MAPS.length) return;
    recordAdminAction(p.name, "マップ変更", MAPS[i].name);
    setMap(i);
  });

  socket.on("admin:announce", (data) => {
    if (!adminOnly()) return;
    const text = String(data?.text ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
    if (!text) return;
    io.emit("announce", { text });
  });

  socket.on("admin:heal", (data) => {
    if (!adminOnly()) return;
    const t = targetOf(data);
    if (!t || !t.q.alive) return;
    t.q.hp = MAX_HP;
    recordAdminAction(p.name, "回復", t.q.name);
  });

  socket.on("admin:freeze", (data) => {
    if (!adminOnly()) return;
    const t = targetOf(data);
    if (!t) return;
    t.q.frozen = !t.q.frozen;
    recordAdminAction(p.name, t.q.frozen ? "凍結" : "凍結解除", t.q.name);
  });

  socket.on("admin:respawn", (data) => {
    if (!adminOnly()) return;
    const t = targetOf(data);
    if (!t) return;
    clearRespawn(t.id);
    spawn(t.q);
    recordAdminAction(p.name, "リスポーン", t.q.name);
  });

  socket.on("admin:bring", (data) => {
    if (!adminOnly()) return;
    const t = targetOf(data);
    if (!t) return;
    placeNear(t.q, p.s.x, p.s.z);
    recordAdminAction(p.name, "呼び寄せ", t.q.name);
  });

  socket.on("admin:goto", (data) => {
    if (!adminOnly()) return;
    const t = targetOf(data);
    if (!t) return;
    placeNear(p, t.q.s.x, t.q.s.z);
    recordAdminAction(p.name, "移動", t.q.name);
  });

  socket.on("admin:resetStats", () => {
    if (!adminOnly()) return;
    for (const q of players.values()) {
      q.kills = 0;
      q.deaths = 0;
    }
    recordAdminAction(p.name, "全員のスコアリセット");
  });

  socket.on("png", (cb) => {
    if (typeof cb === "function") cb();
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    clearRespawn(socket.id);
    const n = (ipCount.get(ip) || 1) - 1;
    if (n <= 0) ipCount.delete(ip);
    else ipCount.set(ip, n);
    broadcastRoster();
    console.log(`leave ${socket.id} (${players.size}/${MAX_PLAYERS})`);
  });
});

// ---- ゲームループ（20Hz）----
const tickTimer = setInterval(() => {
  if (players.size === 0) return;
  const now = Date.now();
  const m = map();
  for (const p of players.values()) {
    if (p.alive && !p.frozen) stepMove(p.s, p.input, p.yaw, TICK, m);
    if (p.reloadUntil && now >= p.reloadUntil) {
      p.ammos[p.weapon] = currentW(p).mag;
      p.reloadUntil = 0;
    }
  }

  const snapshot = {};
  for (const [id, p] of players) {
    const s = p.s;
    snapshot[id] = {
      x: r2(s.x), y: r2(s.y), z: r2(s.z),
      vx: r2(s.vx), vy: r2(s.vy), vz: r2(s.vz), g: s.g,
      yaw: r2(p.yaw),
      hp: p.hp, alive: p.alive, kills: p.kills, deaths: p.deaths,
      w: p.weapon, a: p.ammos[p.weapon], rl: p.reloadUntil > 0, fz: !!p.frozen,
    };
  }
  io.emit("state", snapshot);
}, TICK_MS);

// 3分ごとにマップを切り替える
const rotateTimer = setInterval(() => setMap((mapIdx + 1) % MAPS.length), MAP_ROTATE_MS);

// 1分ごとに違反回数を減らし、期限切れのBANを掃除する
const housekeepingTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, until] of bans) if (until <= now) bans.delete(ip);
  for (const q of players.values()) {
    q.violations = Math.max(0, q.violations - 5);
    q.sus = Math.max(0, q.sus - 1);
  }
}, 60000);

// ---- 起動・終了 ----
http.listen(PORT, "0.0.0.0", () => console.log(`server listening on :${PORT}`));

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  clearInterval(tickTimer);
  clearInterval(rotateTimer);
  clearInterval(housekeepingTimer);
  for (const t of respawnTimers.values()) clearTimeout(t);
  io.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => console.error("uncaught:", err));
