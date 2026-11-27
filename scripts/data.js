/**
 * Custom Spin Wheel v2.0 - ข้อมูล ค่าคงที่ ธีม และตัวทำความสะอาดข้อมูล
 */

export const ID = "custom-spin-wheel";
export const TAU = Math.PI * 2;
export const SIZE = 420;
export const RIM = 10;
export const LIB_DIR = "custom-spin-wheel-data";
export const LIB_FILE = "wheels.json";

export const POINTERS = ["triangle", "arrow", "diamond", "flame", "horns"];
export const RIMS = ["plain", "double", "studs", "spikes", "none"];
export const EFFECTS = ["none", "flash", "confetti", "fireworks", "embers"];
export const SPIN_SOUNDS = ["tick", "none", "file"];
export const WIN_SOUNDS = ["none", "chime", "fanfare", "boom", "file"];
export const RARITIES = ["common", "rare", "epic", "legendary"];
export const HUBS = ["plain", "coin"];
export const FRAMES = ["none", "hellfire"];
export const AMBIENTS = ["none", "spores", "embers"];
export const GENERIC_FONTS = ["serif", "sans-serif", "monospace", "cursive", "fantasy"];
export const EMBER_COLORS = ["#ff6d00", "#ff9100", "#ffab00", "#ff3d00"];
export const RARITY_COLORS = { rare: "#4aa3ff", epic: "#b455ff", legendary: "#ffcc33" };

export const DEFAULT_CURRENCY = { enabled: false, name: "Hell Coin", icon: "🪙", announce: true };

const BASE_STYLE = {
  rim: "#222222", accent: "#ffffff", rimStyle: "plain", pointer: "triangle", pointerColor: "#d32f2f",
  hub: "#222222", font: "Signika", glow: false,
  shade: false, metal: false, lights: false, hubStyle: "plain", frame: "none", ambient: "none"
};

export const THEMES = {
  default: {
    palette: ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e84393", "#95a5a6", "#34495e"],
    style: { ...BASE_STYLE },
    effect: "confetti",
    win: "chime"
  },
  fantasy: {
    palette: ["#5e3c99", "#2c7da0", "#52b788", "#e9c46a", "#c9184a", "#7b2cbf", "#1b4965", "#f4a261"],
    style: {
      ...BASE_STYLE, rim: "#b8860b", accent: "#ffe08a", rimStyle: "studs", pointer: "arrow", pointerColor: "#ffd54f",
      hub: "#3b2a14", font: "Amiri", glow: true, shade: true, metal: true
    },
    effect: "fireworks",
    win: "fanfare"
  },
  hellfire: {
    palette: ["#4a0404", "#8b0000", "#c1121f", "#e85d04", "#f48c06", "#faa307", "#370617", "#9d0208"],
    style: {
      ...BASE_STYLE, rim: "#1a0000", accent: "#ff6d00", rimStyle: "spikes", pointer: "horns", pointerColor: "#ff3d00",
      hub: "#1a0000", font: "Modesto Condensed", glow: true, shade: true, metal: true, lights: true,
      hubStyle: "coin", frame: "hellfire", ambient: "spores"
    },
    effect: "embers",
    win: "boom"
  }
};

export const SYNTH = {
  chime: [
    { f: 880, start: 0, dur: 0.5, type: "sine", gain: 0.6 },
    { f: 1320, start: 0.12, dur: 0.7, type: "sine", gain: 0.5 }
  ],
  fanfare: [
    { f: 523, start: 0, dur: 0.18, type: "square", gain: 0.25 },
    { f: 659, start: 0.16, dur: 0.18, type: "square", gain: 0.25 },
    { f: 784, start: 0.32, dur: 0.18, type: "square", gain: 0.25 },
    { f: 1047, start: 0.5, dur: 0.7, type: "square", gain: 0.3 }
  ],
  boom: [
    { f: 140, f1: 30, start: 0, dur: 0.9, type: "sine", gain: 1 },
    { f: 70, f1: 25, start: 0, dur: 1.1, type: "triangle", gain: 0.7 }
  ],
  coin: [
    { f: 1568, start: 0, dur: 0.12, type: "square", gain: 0.2 },
    { f: 2093, start: 0.09, dur: 0.28, type: "square", gain: 0.2 }
  ]
};

/** ตัวกลางให้ app.js เรียกฟังก์ชันที่ main.js เป็นเจ้าของ (กัน import วนกัน) */
export const bridge = {
  currency: () => ({ ...DEFAULT_CURRENCY }),
  pool: () => ({ balance: 0, log: [] }),
  playerWheels: () => [],
  executeSpin: async () => false,
  requestSpin: () => {},
  adjustPool: async () => false,
  saveCurrency: async () => {},
  redrawAll: () => {}
};

/* ---------------- helpers ---------------- */

export const t = (key, data) =>
  data ? game.i18n.format(`CSW.${key}`, data) : game.i18n.localize(`CSW.${key}`);

export const esc = s => String(s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export const luminance = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

export const rand = (a, b) => a + Math.random() * (b - a);
export const uniform = () => (globalThis.CONFIG?.Dice?.randomUniform ? CONFIG.Dice.randomUniform() : Math.random());
export const fontStack = f => `${GENERIC_FONTS.includes(f) ? f : `"${f}"`}, "Noto Sans Thai", "Sarabun", sans-serif`;
export const slug = s => String(s).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "wheel";
export const isImageSrc = s => /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(s) || /^https?:\/\//i.test(s);

export function iconHTML(icon, cls) {
  icon = String(icon ?? "").trim();
  if (!icon) return "";
  return isImageSrc(icon)
    ? `<img class="${cls}" src="${esc(icon)}" alt="">`
    : `<span class="${cls}">${esc(icon)}</span>`;
}

const randomID = () => globalThis.foundry.utils.randomID();

/* ---------------- wheel data ---------------- */

export function newWheel(name) {
  const th = THEMES.default;
  return {
    id: randomID(),
    name,
    scope: "world",
    duration: 6,
    removeWinner: false,
    postChat: true,
    cost: 0,
    playerSpin: false,
    style: { ...th.style },
    effect: th.effect,
    sounds: { spin: "tick", spinFile: "", win: th.win, winFile: "" },
    segments: Array.from({ length: 6 }, (_, i) => ({
      label: `${t("Option")} ${i + 1}`,
      icon: "",
      color: th.palette[i % th.palette.length],
      weight: 1,
      rarity: "common"
    }))
  };
}

/** วงล้อเก่า (v1.0 / v1.1) ที่ไม่มีฟิลด์ใหม่จะถูกเติมค่าเริ่มต้นให้อัตโนมัติ */
export function sanitizeWheel(raw, newId = false) {
  raw = raw && typeof raw === "object" ? raw : {};
  const D = THEMES.default;
  const st = raw.style && typeof raw.style === "object" ? raw.style : {};
  const so = raw.sounds && typeof raw.sounds === "object" ? raw.sounds : {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const num = (v, min, max, d) => {
    v = Number(v);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  };
  const segments = (Array.isArray(raw.segments) ? raw.segments : []).slice(0, 200).map((s, i) => ({
    label: String(s?.label ?? "").slice(0, 80),
    icon: String(s?.icon ?? "").slice(0, 300),
    color: hex(s?.color, D.palette[i % D.palette.length]),
    weight: num(s?.weight, 0, 1000, 1),
    rarity: pick(s?.rarity, RARITIES, "common")
  }));
  const scope = raw.scope === "global" ? "global" : "world";
  return {
    id: !newId && typeof raw.id === "string" && raw.id ? raw.id.slice(0, 32) : randomID(),
    name: String(raw.name ?? "").slice(0, 60) || "Wheel",
    scope,
    duration: num(raw.duration, 2, 30, 6),
    removeWinner: !!raw.removeWinner,
    postChat: raw.postChat !== false,
    cost: Math.round(num(raw.cost, 0, 9999, 0)),
    playerSpin: scope === "global" ? false : !!raw.playerSpin,
    style: {
      rim: hex(st.rim, D.style.rim),
      accent: hex(st.accent, D.style.accent),
      rimStyle: pick(st.rimStyle, RIMS, "plain"),
      pointer: pick(st.pointer, POINTERS, "triangle"),
      pointerColor: hex(st.pointerColor, D.style.pointerColor),
      hub: hex(st.hub, D.style.hub),
      font: String(st.font ?? D.style.font).slice(0, 60) || D.style.font,
      glow: !!st.glow,
      shade: !!st.shade,
      metal: !!st.metal,
      lights: !!st.lights,
      hubStyle: pick(st.hubStyle, HUBS, "plain"),
      frame: pick(st.frame, FRAMES, "none"),
      ambient: pick(st.ambient, AMBIENTS, "none")
    },
    effect: pick(raw.effect, EFFECTS, "confetti"),
    sounds: {
      spin: pick(so.spin, SPIN_SOUNDS, "tick"),
      spinFile: String(so.spinFile ?? "").slice(0, 300),
      win: pick(so.win, WIN_SOUNDS, "chime"),
      winFile: String(so.winFile ?? "").slice(0, 300)
    },
    segments
  };
}

export function applyTheme(wheel, id) {
  const th = THEMES[id];
  if (!th) return;
  wheel.style = { ...th.style };
  wheel.effect = th.effect;
  wheel.sounds.win = th.win;
  wheel.segments.forEach((s, i) => { s.color = th.palette[i % th.palette.length]; });
}

/* ---------------- currency & pool ---------------- */

export function sanitizeCurrency(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: !!raw.enabled,
    name: String(raw.name ?? "").trim().slice(0, 30) || DEFAULT_CURRENCY.name,
    icon: String(raw.icon ?? DEFAULT_CURRENCY.icon).trim().slice(0, 300) || DEFAULT_CURRENCY.icon,
    announce: raw.announce !== false
  };
}

export function sanitizePool(raw) {
  const bal = Math.floor(Number(raw?.balance));
  return {
    balance: Number.isFinite(bal) ? Math.min(999999999, Math.max(0, bal)) : 0,
    log: (Array.isArray(raw?.log) ? raw.log : []).slice(0, 50).map(e => ({
      t: Number(e?.t) || 0,
      who: String(e?.who ?? "").slice(0, 40),
      d: Math.trunc(Number(e?.d)) || 0,
      why: String(e?.why ?? "").slice(0, 80)
    }))
  };
}
