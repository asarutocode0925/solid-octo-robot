import { WEAPON_ORDER, WEAPONS, SKINS, SKIN_ORDER } from "../shared/game.js";

const KEY = "clanker-settings";

export const DEFAULTS = {
  sens: 1,
  touchSens: 1,
  fov: 75,
  volume: 0.7,
  showFps: true,
  name: "ロボット",
  adminKey: "",
  skins: {},
  knifeModel: "tanto",
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...saved, skins: { ...(saved.skins || {}) } };
  } catch {
    return { ...DEFAULTS, skins: {} };
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

// 設定画面の要素を初期化し、変更時にonChangeを呼ぶ
export function bindSettings(s, onChange) {
  const $ = (id) => document.getElementById(id);

  const sens = $("set-sens");
  const touch = $("set-touch");
  const fov = $("set-fov");
  const vol = $("set-vol");
  const fps = $("set-fps");
  const name = $("set-name");
  const adminKey = $("set-admin");
  const skinW = $("set-skin-weapon");
  const skinS = $("set-skin");
  const knifeSel = $("set-knife");
  knifeSel.value = s.knifeModel;

  for (const k of WEAPON_ORDER) {
    if (WEAPONS[k].melee) continue;
    const o = document.createElement("option");
    o.value = k;
    o.textContent = WEAPONS[k].label;
    skinW.appendChild(o);
  }
  for (const k of SKIN_ORDER) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = SKINS[k].name;
    skinS.appendChild(o);
  }

  const syncFields = () => {
    sens.value = s.sens;
    touch.value = s.touchSens;
    fov.value = s.fov;
    vol.value = s.volume;
    fps.checked = s.showFps;
    name.value = s.name;
    adminKey.value = s.adminKey;
    skinS.value = s.skins[skinW.value] ?? "std";
  };
  syncFields();

  skinW.addEventListener("change", () => {
    skinS.value = s.skins[skinW.value] ?? "std";
  });

  const apply = (patch) => {
    Object.assign(s, patch);
    saveSettings(s);
    onChange(s, patch);
  };

  sens.addEventListener("input", () => apply({ sens: Number(sens.value) }));
  touch.addEventListener("input", () => apply({ touchSens: Number(touch.value) }));
  fov.addEventListener("input", () => apply({ fov: Number(fov.value) }));
  vol.addEventListener("input", () => apply({ volume: Number(vol.value) }));
  fps.addEventListener("change", () => apply({ showFps: fps.checked }));
  name.addEventListener("change", () => apply({ name: name.value.trim().slice(0, 12) || "ロボット" }));
  adminKey.addEventListener("change", () => apply({ adminKey: adminKey.value }));
  knifeSel.addEventListener("change", () => apply({ knifeModel: knifeSel.value }));
  skinS.addEventListener("change", () => {
    const skins = { ...s.skins, [skinW.value]: skinS.value };
    apply({ skins });
  });

  return { syncFields };
}
