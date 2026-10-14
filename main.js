import * as THREE from "three";
import { io } from "socket.io-client";
import { MAPS, MAP_DECO, WEAPONS, WEAPON_ORDER, TICK, EYE_H, newPhys, stepMove } from "../shared/game.js";
import { buildViewModel, disposeViewModel, buildDeco, disposeDeco } from "./view.js";
import { loadSettings, bindSettings } from "./settings.js";

// ---- 設定 ----
const SERVER_URL = import.meta.env.DEV ? "http://localhost:3000" : undefined;
const INPUT_SEND_MS = 50;
const AUTO_FIRE_MS = 50;
const STICK_R = 60;
const MOUSE_BASE = 0.002;
const TOUCH_BASE = 0.006;
const SNAP_XZ = 2;
const SNAP_Y = 1.5;
const REMOTE_LERP = 0.25;
const KILLFEED_MAX = 5;
const KILLFEED_MS = 5000;
const MAX_STEPS = 5;

const settings = loadSettings();
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));
const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
if (isTouch) document.body.classList.add("touch");

// ---- Three.js ----
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);
scene.fog = new THREE.Fog(0x1a1d24, 40, 120);

const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.1, 300);
camera.rotation.order = "YXZ";
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(10, 20, 10);
scene.add(sun);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- マップ ----
const mapGroup = new THREE.Group();
scene.add(mapGroup);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x667788, roughness: 0.8 });
let currentMap = MAPS[0];

let decoGroup = null;

function clearMap() {
  if (decoGroup) {
    disposeDeco(decoGroup);
    decoGroup = null;
  }
  for (const c of mapGroup.children) {
    if (c.geometry && c.geometry !== boxGeo) c.geometry.dispose();
    if (c.material && c.material !== wallMat) {
      // THREE.GridHelper uses an array of materials; dispose each one safely.
      const materials = Array.isArray(c.material) ? c.material : [c.material];
      for (const material of materials) material?.dispose?.();
    }
  }
  mapGroup.clear();
}

function buildMap(i) {
  currentMap = MAPS[i] ?? MAPS[0];
  clearMap();
  scene.background.set(currentMap.sky);
  scene.fog.color.set(currentMap.fog ?? currentMap.sky);
  const size = currentMap.bound * 2.5;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: currentMap.color })
  );
  floor.rotation.x = -Math.PI / 2;
  mapGroup.add(floor);
  mapGroup.add(new THREE.GridHelper(size, 50, 0x445566, 0x2a3140));
  for (const b of currentMap.boxes) {
    const m = new THREE.Mesh(boxGeo, wallMat);
    m.scale.set(b.w, b.h, b.d);
    m.position.set(b.x, b.h / 2, b.z);
    mapGroup.add(m);
  }
  decoGroup = buildDeco(MAP_DECO[i] ?? []);
  mapGroup.add(decoGroup);
  announce(`マップ：${currentMap.name}`);
  sfxMapChange();
}

// ---- ロボット（共有リソース）----
const robotBodyGeo = new THREE.BoxGeometry(0.8, 1.0, 0.6);
const robotHeadGeo = new THREE.BoxGeometry(0.6, 0.5, 0.6);
const robotEyeGeo = new THREE.BoxGeometry(0.4, 0.1, 0.05);
const robotMat = new THREE.MeshStandardMaterial({ color: 0xc0c8d4, metalness: 0.6, roughness: 0.4 });
const robotEyeMat = new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0xff3322 });

function makeRobot() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(robotBodyGeo, robotMat);
  body.position.y = 1.0;
  const head = new THREE.Mesh(robotHeadGeo, robotMat);
  head.position.y = 1.9;
  const eye = new THREE.Mesh(robotEyeGeo, robotEyeMat);
  eye.position.set(0, 1.95, -0.33);
  g.add(body, head, eye);
  return g;
}

// ---- 一人称の武器 ----
const vmRoot = new THREE.Group();
vmRoot.position.set(0.28, -0.26, -0.5);
camera.add(vmRoot);
let vm = null;
let vmKey = "";
let recoil = 0;
let swing = 0;

function refreshViewModel(weaponIdx) {
  const wk = WEAPON_ORDER[weaponIdx];
  const sk = settings.skins[wk] ?? "std";
  const model = wk === "knife" ? settings.knifeModel : "";
  const key = `${wk}:${sk}:${model}`;
  if (key === vmKey) return;
  vmKey = key;
  if (vm) {
    vmRoot.remove(vm);
    disposeViewModel(vm);
  }
  vm = buildViewModel(wk, sk, model);
  vmRoot.add(vm);
}

const tracerMat = new THREE.LineBasicMaterial({ color: 0xffdd66 });

// ---- UI ----
const hud = document.getElementById("hud");
const msg = document.getElementById("msg");
const cross = document.getElementById("cross");
const hint = document.getElementById("hint");
const board = document.getElementById("board");
const killfeed = document.getElementById("killfeed");
const labels = document.getElementById("labels");
const fpsEl = document.getElementById("fps");
const netEl = document.getElementById("net");
const panel = document.getElementById("settings");
const stick = document.getElementById("stick");
const knob = document.getElementById("knob");
const fireBtn = document.getElementById("fire");
const reloadBtn = document.getElementById("reload");
const swapBtn = document.getElementById("swap");
const jumpBtn = document.getElementById("jump");
const gearBtn = document.getElementById("gear");
fpsEl.style.display = settings.showFps ? "block" : "none";

let hudText = "";
function setHud(text) {
  if (text === hudText) return;
  hudText = text;
  hud.innerHTML = text;
}

function flashMsg(text, ms = 1200) {
  msg.textContent = text;
  msg.style.opacity = 1;
  clearTimeout(flashMsg.t);
  flashMsg.t = setTimeout(() => (msg.style.opacity = 0), ms);
}
const announce = (text) => flashMsg(text, 1500);

// 名前表示：管理者には虹色の [Admin] を名前の左に付ける
const nameHtml = (info) =>
  (info.a ? '<span class="admin">[Admin]</span> ' : "") + `<span>${esc(info.n)}</span>`;

function addKill({ k, v, w, h }) {
  const el = document.createElement("div");
  el.innerHTML = `${nameHtml(k)} ▶ ${nameHtml(v)}（${esc(w)}${h ? " / ヘッド" : ""}）`;
  killfeed.prepend(el);
  while (killfeed.children.length > KILLFEED_MAX) killfeed.lastChild.remove();
  setTimeout(() => el.remove(), KILLFEED_MS);
}

function renderHud() {
  if (!self) return;
  const w = WEAPONS[WEAPON_ORDER[self.w]];
  const ammo = w.melee ? "" : `<br>${self.rl ? "リロード中…" : `${self.a} / ${w.mag}`}`;
  setHud(
    `HP: ${self.alive ? self.hp : 0}<br>` +
    `${w.label}${ammo}<br>` +
    `KILLS: ${self.kills}  DEATHS: ${self.deaths}`
  );
}

function renderBoard() {
  const rows = Object.entries(lastState)
    .sort((a, b) => b[1].kills - a[1].kills || a[1].deaths - b[1].deaths)
    .map(([id, p]) => {
      const info = roster[id] ?? { n: "?", a: false };
      return `<tr class="${id === socket.id ? "me" : ""}"><td>${nameHtml(info)}</td>` +
        `<td>${p.kills}</td><td>${p.deaths}</td></tr>`;
    })
    .join("");
  board.innerHTML =
    `<div class="title">${esc(currentMap.name)}</div>` +
    `<table><tr><th>名前</th><th>K</th><th>D</th></tr>${rows}</table>`;
}

// ---- 効果音（Web Audio・音声ファイル不要）----
let ac = null;
let master = null;
let noiseBuf = null;
function audio() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    master = ac.createGain();
    master.gain.value = settings.volume;
    master.connect(ac.destination);
  }
  if (ac.state === "suspended") ac.resume();
  return ac;
}
addEventListener("pointerdown", () => audio(), { once: true });

function sfxShot(s) {
  if (!ac) return;
  const t = ac.currentTime;
  if (!noiseBuf) {
    const len = Math.floor(ac.sampleRate * 0.3);
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = s.f * 4;
  const g = ac.createGain();
  g.gain.setValueAtTime(s.v, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + s.d);
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + s.d);
}

function sfxTone(from, to, dur, vol) {
  if (!ac) return;
  const t = ac.currentTime;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur);
}
const sfxHit = () => sfxTone(1200, 1000, 0.06, 0.2);

// 音の並び（ドーパミンが出るような、短く明るい連続音）
function sfxSeq(notes, step, type, vol) {
  if (!ac) return;
  const t0 = ac.currentTime;
  notes.forEach((f, i) => {
    const t = t0 + i * step;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + step * 1.2);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + step * 1.3);
  });
}

// 短いカチッという音（リロード・足音）
function ensureNoise() {
  if (!ac) return null;
  if (!noiseBuf) {
    const len = Math.floor(ac.sampleRate * 0.3);
    noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function sfxClick(vol = 0.06) {
  if (!ac || !ensureNoise()) return;
  const t = ac.currentTime;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 2400;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  src.connect(f).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.04);
}

const sfxKill = () => sfxSeq([660, 880, 1320], 0.06, "square", 0.18);
const sfxHead = () => sfxSeq([1320, 1760, 2640], 0.05, "triangle", 0.25);
const sfxStreak = () => sfxSeq([523, 659, 784, 1047, 1319], 0.08, "sawtooth", 0.15);
const sfxReloadStart = () => { sfxClick(0.08); setTimeout(() => sfxClick(0.06), 220); };
const sfxReloadDone = () => sfxSeq([988, 1319], 0.05, "square", 0.12);
const sfxAnnounce = () => sfxSeq([880, 1100], 0.1, "sine", 0.2);
const sfxMapChange = () => sfxSeq([220, 330, 440], 0.09, "triangle", 0.2);
const sfxDeath = () => sfxTone(400, 80, 0.4, 0.3);

// ---- 入力 ----
const keys = {};
const touch = { x: 0, z: 0, jump: false };
let yaw = 0;
let pitch = 0;
let lastShot = 0;
let lastSent = { x: NaN, z: NaN, j: false, yaw: NaN };
let fireHeld = false;
let mouseHeld = false;
let paused = false;   // 設定画面を開いている間は操作を止める

function currentInput() {
  if (paused) return { x: 0, z: 0, j: false };
  const kx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const kz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  return {
    x: clamp(kx + touch.x, -1, 1),
    z: clamp(kz + touch.z, -1, 1),
    j: !!keys.Space || touch.jump,
  };
}

// ---- ネットワーク ----
const socket = io(SERVER_URL, { reconnectionAttempts: 10 });
const remotes = new Map();   // id -> { mesh, el, tx, ty, tz, tyaw }
let self = null;
let pred = newPhys();        // 予測した自分の物理状態
let prevPos = null;
let reconciled = false;
let acc = 0;
let lastState = {};
let roster = {};
let wasReloading = false;
let stepDist = 0;

function sendJoin() {
  socket.emit("join", { name: settings.name, key: settings.adminKey });
}

function refreshLabel(id, r) {
  r.el.innerHTML = nameHtml(roster[id] ?? { n: "…", a: false });
}

function ensureRemote(id, p) {
  let r = remotes.get(id);
  if (!r) {
    const mesh = makeRobot();
    mesh.position.set(p.x, p.y, p.z);
    scene.add(mesh);
    const el = document.createElement("div");
    el.className = "tag";
    labels.appendChild(el);
    r = { mesh, el, tx: p.x, ty: p.y, tz: p.z, tyaw: p.yaw };
    remotes.set(id, r);
    refreshLabel(id, r);
  }
  return r;
}

function clearRemotes() {
  for (const r of remotes.values()) {
    scene.remove(r.mesh);
    r.el.remove();
  }
  remotes.clear();
}

socket.on("connect", () => {
  sendJoin();
  flashMsg("接続しました", 800);
});
socket.on("connect_error", (e) => {
  const text = e.message === "banned" ? "アクセスが制限されています"
    : e.message === "full" ? "満員です"
    : e.message === "too many connections" ? "接続数が多すぎます"
    : "サーバーに接続できません";
  flashMsg(text, 4000);
});
socket.on("disconnect", () => {
  clearRemotes();
  self = null;
  reconciled = false;
  flashMsg("切断されました。再接続中…", 3000);
});
socket.on("full", () => flashMsg("満員です。しばらく待ってください", 5000));
socket.on("map", ({ i }) => {
  buildMap(i);
  reconciled = false;
});
socket.on("announce", ({ text }) => {
  flashMsg(`📢 ${text}`, 4000);
  sfxAnnounce();
});
socket.on("roster", (r) => {
  roster = r;
  adminBtn.style.display = roster[socket.id]?.a ? "flex" : "none";
  for (const [id, rem] of remotes) refreshLabel(id, rem);
  if (board.style.display === "block") renderBoard();
});
socket.on("kill", (d) => {
  addKill(d);
  if (d.ki === socket.id) sfxKill();
});
socket.on("streak", ({ n }) => {
  announce(`${n}連続キル！`);
  sfxStreak();
});

socket.on("hitmark", ({ head } = {}) => {
  cross.classList.add("hit");
  setTimeout(() => cross.classList.remove("hit"), 150);
  if (head) {
    flashMsg("ヘッドショット！", 500);
    sfxHead();
  } else {
    sfxHit();
  }
});
socket.on("died", () => {
  flashMsg("撃破された！ 3秒後に復活", 2000);
  sfxDeath();
});

socket.on("state", (state) => {
  lastState = state;

  for (const [id, p] of Object.entries(state)) {
    if (id === socket.id) continue;
    const r = ensureRemote(id, p);
    r.tx = p.x;
    r.ty = p.y;
    r.tz = p.z;
    r.tyaw = p.yaw;
    r.mesh.visible = p.alive;
  }
  for (const [id, r] of remotes) {
    if (!state[id]) {
      scene.remove(r.mesh);
      r.el.remove();
      remotes.delete(id);
    }
  }

  self = state[socket.id] ?? null;
  if (self) {
    if (self.rl !== wasReloading) {
      if (self.rl) sfxReloadStart();
      else sfxReloadDone();
      wasReloading = self.rl;
    }
    renderHud();
    refreshViewModel(self.w);
    // 予測と大きくずれたらサーバーの値へ補正（リスポーン・衝突の不一致など）
    const far =
      Math.hypot(pred.x - self.x, pred.z - self.z) > SNAP_XZ ||
      Math.abs(pred.y - self.y) > SNAP_Y;
    if (!reconciled || far) {
      pred = newPhys(self.x, self.z);
      pred.y = self.y;
      pred.vx = self.vx;
      pred.vy = self.vy;
      pred.vz = self.vz;
      pred.g = self.g;
      prevPos = { x: pred.x, y: pred.y, z: pred.z };
      reconciled = true;
      acc = 0;
    }
  } else {
    reconciled = false;
  }
  if (board.style.display === "block") renderBoard();
});

// 入力を変化時のみ送信（通信量削減）
setInterval(() => {
  const { x, z, j } = currentInput();
  if (x === lastSent.x && z === lastSent.z && j === lastSent.j && Math.abs(yaw - lastSent.yaw) < 0.001) return;
  lastSent = { x, z, j, yaw };
  socket.emit("input", { x, z, j, yaw });
}, INPUT_SEND_MS);

// 通信遅延の計測
setInterval(() => {
  const t = performance.now();
  socket.emit("png", () => {
    netEl.textContent = `PING ${Math.round(performance.now() - t)} ms`;
  });
}, 2000);

// ---- 射撃・リロード・武器切替 ----
function shoot() {
  if (paused || !self || !self.alive || self.rl) return;
  const w = WEAPONS[WEAPON_ORDER[self.w]];
  const now = performance.now();
  if (now - lastShot < w.cooldown) return;
  if (!w.melee && self.a <= 0) {
    socket.emit("reload");
    return;
  }
  lastShot = now;
  socket.emit("shoot", { yaw, pitch });
  sfxShot(w.sound);
  if (w.melee) {
    swing = 1;
  } else {
    recoil = 1;
    drawTracer();
    flashMuzzle();
  }
}

const switchWeapon = (i) => socket.emit("switch", { i });
const reload = () => socket.emit("reload");

setInterval(() => {
  if (!self) return;
  if ((fireHeld || mouseHeld) && WEAPONS[WEAPON_ORDER[self.w]].auto) shoot();
}, AUTO_FIRE_MS);

// マズルフラッシュ（発砲時だけ一瞬表示）
function flashMuzzle() {
  const f = vm?.getObjectByName("flash");
  if (!f) return;
  f.visible = true;
  clearTimeout(flashMuzzle.t);
  flashMuzzle.t = setTimeout(() => (f.visible = false), 50);
}

const tracerDir = new THREE.Vector3();
function drawTracer() {
  camera.getWorldDirection(tracerDir);
  const from = camera.position.clone().addScaledVector(tracerDir, 0.5);
  const to = camera.position.clone().addScaledVector(tracerDir, 60);
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat);
  scene.add(line);
  setTimeout(() => {
    scene.remove(line);
    geo.dispose();
  }, 80);
}

// ---- 設定画面 ----
function openSettings() {
  paused = true;
  panel.style.display = "block";
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeSettings() {
  paused = false;
  panel.style.display = "none";
}
document.getElementById("set-close").addEventListener("click", closeSettings);
gearBtn.addEventListener("click", openSettings);

const settingsUI = bindSettings(settings, (s, patch) => {
  if ("fov" in patch) {
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
  }
  if ("volume" in patch && master) master.gain.value = s.volume;
  if ("showFps" in patch) fpsEl.style.display = s.showFps ? "block" : "none";
  if ("name" in patch || "adminKey" in patch) sendJoin();
  if ("knifeModel" in patch) vmKey = "";
  if ("skins" in patch) {
    vmKey = "";
    if (self) refreshViewModel(self.w);
  }
});
settingsUI.syncFields();

// ---- 管理者パネル（管理者のみ開ける。操作はサーバー側でも再確認される）----
const adminPanel = document.getElementById("admin");
const adminList = document.getElementById("admin-list");
const adminBtn = document.getElementById("admin-btn");
const adminSay = document.getElementById("admin-say");

const isAdmin = () => !!roster[socket.id]?.a;

function renderAdmin() {
  if (adminPanel.style.display !== "block" || !isAdmin()) return;
  adminList.innerHTML = Object.entries(lastState)
    .map(([id, p]) => {
      const info = roster[id] ?? { n: "?", a: false };
      const btn = (act, label) => `<button data-act="${act}" data-id="${esc(id)}">${label}</button>`;
      const actions = id === socket.id ? "" :
        btn("kick", "キック") + btn("heal", "回復") +
        btn("freeze", p.fz ? "解凍" : "凍結") + btn("bring", "呼寄") +
        btn("goto", "移動") + btn("respawn", "復活");
      const dead = p.alive ? "" : " <small>(死亡中)</small>";
      return `<div class="arow"><span>${nameHtml(info)} <small>K${p.kills} D${p.deaths}</small>${dead}</span><span class="acts">${actions}</span></div>`;
    })
    .join("");
}
setInterval(renderAdmin, 1000); // 操作中にDOMを作り直さないよう1秒ごとに更新

function openAdmin() {
  if (!isAdmin()) return;
  paused = true;
  adminPanel.style.display = "block";
  if (document.pointerLockElement) document.exitPointerLock();
  renderAdmin();
}
function closeAdmin() {
  paused = false;
  adminPanel.style.display = "none";
}

adminBtn.addEventListener("click", openAdmin);
document.getElementById("admin-close").addEventListener("click", closeAdmin);
adminList.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  const id = b.dataset.id;
  if (act === "kick" && !confirm("このプレイヤーをキックしますか？")) return;
  socket.emit(`admin:${act}`, { id });
});

document.getElementById("admin-reset").addEventListener("click", () => {
  if (confirm("全員のキル・デス数をリセットしますか？")) socket.emit("admin:resetStats");
});

socket.on("adminlog", (lines) => {
  document.getElementById("admin-log").innerHTML = lines
    .slice()
    .reverse()
    .map((l) => {
      const time = new Date(l.t).toLocaleTimeString("ja-JP");
      const target = l.target ? `（${esc(l.target)}）` : "";
      return `<div>${time} ${esc(l.by)}：${esc(l.action)}${target}</div>`;
    })
    .join("");
});
const adminMaps = document.getElementById("admin-maps");
MAPS.forEach((m, i) => {
  const b = document.createElement("button");
  b.textContent = m.name;
  b.addEventListener("click", () => socket.emit("admin:map", { i }));
  adminMaps.appendChild(b);
});
document.getElementById("admin-say-btn").addEventListener("click", () => {
  const t = adminSay.value.trim();
  if (!t) return;
  socket.emit("admin:announce", { text: t });
  adminSay.value = "";
});

// ---- キーボード・マウス ----
addEventListener("keydown", (e) => {
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // 入力中はゲーム操作しない
  if (e.code === "Space") e.preventDefault();
  if (e.repeat && e.code !== "Space") return;
  keys[e.code] = true;
  if (e.code === "KeyO") {
    paused ? closeSettings() : openSettings();
    return;
  }
  if (e.code === "KeyP") {
    adminPanel.style.display === "block" ? closeAdmin() : openAdmin();
    return;
  }
  if (paused) return;
  if (e.code === "Tab") {
    e.preventDefault();
    board.style.display = "block";
    renderBoard();
  }
  if (e.code === "KeyR") reload();
  const m = /^Digit([1-9])$/.exec(e.code);
  if (m && Number(m[1]) <= WEAPON_ORDER.length) switchWeapon(Number(m[1]) - 1);
});
addEventListener("keyup", (e) => {
  keys[e.code] = false;
  if (e.code === "Tab") board.style.display = "none";
});
// フォーカスが外れたら押しっぱなしを解除（バグ防止）
addEventListener("blur", () => {
  for (const k in keys) keys[k] = false;
  fireHeld = false;
  mouseHeld = false;
  board.style.display = "none";
});

const canvas = renderer.domElement;
canvas.addEventListener("mousedown", (e) => {
  if (isTouch || e.button !== 0 || paused) return;
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
    return;
  }
  mouseHeld = true;
  shoot();
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) mouseHeld = false;
});
document.addEventListener("pointerlockchange", () => {
  hint.style.display = document.pointerLockElement === canvas ? "none" : "block";
});
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas || paused) return;
  yaw -= e.movementX * MOUSE_BASE * settings.sens;
  pitch = clamp(pitch - e.movementY * MOUSE_BASE * settings.sens, -1.4, 1.4);
});

// ---- タッチ ----
let stickId = null;
let lookId = null;
let fireId = null;
let jumpId = null;
let lastLook = { x: 0, y: 0 };

function updateStick(t) {
  const r = stick.getBoundingClientRect();
  let dx = t.clientX - (r.left + r.width / 2);
  let dy = t.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) {
    dx = (dx / d) * STICK_R;
    dy = (dy / d) * STICK_R;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  touch.x = dx / STICK_R;
  touch.z = -dy / STICK_R;
}

function resetStick() {
  touch.x = 0;
  touch.z = 0;
  knob.style.transform = "";
}

addEventListener("touchstart", (e) => {
  if (paused || gearBtn.contains(e.target) || adminBtn.contains(e.target)) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    const el = t.target;
    if (fireBtn.contains(el)) {
      fireId = t.identifier;
      fireHeld = true;
      shoot();
    } else if (jumpBtn.contains(el)) {
      jumpId = t.identifier;
      touch.jump = true;
    } else if (reloadBtn.contains(el)) {
      reload();
    } else if (swapBtn.contains(el)) {
      if (self) switchWeapon((self.w + 1) % WEAPON_ORDER.length);
    } else if (stick.contains(el)) {
      stickId = t.identifier;
      updateStick(t);
    } else if (lookId === null) {
      lookId = t.identifier;
      lastLook = { x: t.clientX, y: t.clientY };
    }
  }
}, { passive: false });

addEventListener("touchmove", (e) => {
  if (paused) return;
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) {
      updateStick(t);
    } else if (t.identifier === lookId) {
      const k = TOUCH_BASE * settings.touchSens;
      yaw -= (t.clientX - lastLook.x) * k;
      pitch = clamp(pitch - (t.clientY - lastLook.y) * k, -1.4, 1.4);
      lastLook = { x: t.clientX, y: t.clientY };
    }
  }
}, { passive: false });

function endTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) {
      stickId = null;
      resetStick();
    }
    if (t.identifier === lookId) lookId = null;
    if (t.identifier === fireId) {
      fireId = null;
      fireHeld = false;
    }
    if (t.identifier === jumpId) {
      jumpId = null;
      touch.jump = false;
    }
  }
}
addEventListener("touchend", endTouch);
addEventListener("touchcancel", endTouch);

// ---- 描画ループ ----
const tmp = new THREE.Vector3();
let lastFrame = performance.now();
let fpsFrames = 0;
let fpsT = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  // FPS表示（0.5秒ごと）
  fpsFrames++;
  if (now - fpsT >= 500) {
    fpsEl.textContent = `FPS ${Math.round((fpsFrames * 1000) / (now - fpsT))}`;
    fpsFrames = 0;
    fpsT = now;
  }

  // 自分：固定刻み（サーバーと同じ TICK）で予測し、描画は補間して滑らかに
  if (reconciled && self && self.alive) {
    acc += dt;
    let steps = 0;
    while (acc >= TICK && steps < MAX_STEPS) {
      prevPos = { x: pred.x, y: pred.y, z: pred.z };
      stepMove(pred, currentInput(), yaw, TICK, currentMap);
      acc -= TICK;
      steps++;
    }
    if (steps >= MAX_STEPS) acc = 0;
    const a = acc / TICK;
    const moveIn = currentInput();
    if (pred.g && (moveIn.x || moveIn.z)) {
      stepDist += Math.hypot(pred.x - (prevPos?.x ?? pred.x), pred.z - (prevPos?.z ?? pred.z));
      if (stepDist > 2.2) {
        stepDist = 0;
        sfxClick(0.04);
      }
    }
    const p0 = prevPos ?? pred;
    camera.position.set(
      p0.x + (pred.x - p0.x) * a,
      p0.y + (pred.y - p0.y) * a + EYE_H,
      p0.z + (pred.z - p0.z) * a
    );
  }
  camera.rotation.set(pitch, yaw, 0);

  // 武器のリコイル・近接の振り
  if (recoil > 0) recoil = Math.max(0, recoil - dt * 10);
  vmRoot.position.set(0.28, -0.26 + recoil * 0.02, -0.5 + recoil * 0.06);
  if (swing > 0) swing = Math.max(0, swing - dt * 4);
  if (vm) vm.rotation.x = -Math.sin(swing * Math.PI) * 0.9;

  // 他プレイヤー：補間
  for (const r of remotes.values()) {
    r.mesh.position.x += (r.tx - r.mesh.position.x) * REMOTE_LERP;
    r.mesh.position.y += (r.ty - r.mesh.position.y) * REMOTE_LERP;
    r.mesh.position.z += (r.tz - r.mesh.position.z) * REMOTE_LERP;
    r.mesh.rotation.y = r.tyaw;
  }

  renderer.render(scene, camera);

  // 名前ラベルを画面座標に追従
  for (const [, r] of remotes) {
    if (!r.mesh.visible) {
      r.el.style.display = "none";
      continue;
    }
    tmp.set(r.mesh.position.x, r.mesh.position.y + 2.4, r.mesh.position.z).project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) {
      r.el.style.display = "none";
      continue;
    }
    const x = (tmp.x * 0.5 + 0.5) * innerWidth;
    const y = (-tmp.y * 0.5 + 0.5) * innerHeight;
    r.el.style.display = "block";
    r.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }
});
