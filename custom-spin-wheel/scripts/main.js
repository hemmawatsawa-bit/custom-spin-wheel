/**
 * Custom Spin Wheel v1.1 - Foundry VTT v13
 * - GM: เปิดหน้าต่างจากปุ่มวงล้อใน Token Controls แก้ไขแล้วกดหมุน
 * - ผู้เล่นทุกคนเห็นวงล้อหมุนและผลลัพธ์เดียวกันผ่าน socket
 * - Macro: game.modules.get("custom-spin-wheel").api.spin("ชื่อวงล้อ")
 */

const ID = "custom-spin-wheel";
const TAU = Math.PI * 2;
const SIZE = 420; // พื้นที่วาดแบบ logical (ภาพจะถูกสเกลตามขนาดหน้าต่าง)
const RIM = 10;
const LIB_DIR = "custom-spin-wheel-data";
const LIB_FILE = "wheels.json";

const POINTERS = ["triangle", "arrow", "diamond", "flame"];
const RIMS = ["plain", "double", "studs", "none"];
const EFFECTS = ["none", "flash", "confetti", "fireworks", "embers"];
const SPIN_SOUNDS = ["tick", "none", "file"];
const WIN_SOUNDS = ["none", "chime", "fanfare", "boom", "file"];
const GENERIC_FONTS = ["serif", "sans-serif", "monospace", "cursive", "fantasy"];
const EMBER_COLORS = ["#ff6d00", "#ff9100", "#ffab00", "#ff3d00"];

const THEMES = {
  default: {
    palette: ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e84393", "#95a5a6", "#34495e"],
    style: { rim: "#222222", accent: "#ffffff", rimStyle: "plain", pointer: "triangle", pointerColor: "#d32f2f", hub: "#222222", font: "Signika", glow: false },
    effect: "confetti",
    win: "chime"
  },
  fantasy: {
    palette: ["#5e3c99", "#2c7da0", "#52b788", "#e9c46a", "#c9184a", "#7b2cbf", "#1b4965", "#f4a261"],
    style: { rim: "#b8860b", accent: "#ffe08a", rimStyle: "studs", pointer: "arrow", pointerColor: "#ffd54f", hub: "#3b2a14", font: "Amiri", glow: true },
    effect: "fireworks",
    win: "fanfare"
  },
  hellfire: {
    palette: ["#4a0404", "#8b0000", "#c1121f", "#e85d04", "#f48c06", "#faa307", "#370617", "#9d0208"],
    style: { rim: "#1a0000", accent: "#ff6d00", rimStyle: "double", pointer: "flame", pointerColor: "#ff3d00", hub: "#1a0000", font: "Modesto Condensed", glow: true },
    effect: "embers",
    win: "boom"
  }
};

// เสียงสังเคราะห์ (ไม่ต้องใช้ไฟล์)
const SYNTH = {
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
  ]
};

let editor = null;
let viewer = null;

/* ---------------- helpers ---------------- */

const t = (key, data) =>
  data ? game.i18n.format(`CSW.${key}`, data) : game.i18n.localize(`CSW.${key}`);

const esc = s => String(s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const luminance = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

const rand = (a, b) => a + Math.random() * (b - a);
const uniform = () => (CONFIG.Dice?.randomUniform ? CONFIG.Dice.randomUniform() : Math.random());
const fontStack = f => `${GENERIC_FONTS.includes(f) ? f : `"${f}"`}, "Noto Sans Thai", "Sarabun", sans-serif`;
const filePicker = () => foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
const audioHelper = () => foundry.audio?.AudioHelper ?? AudioHelper;
const isMuted = () => game.settings.get(ID, "mute");
const slug = s => String(s).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40) || "wheel";

function interfaceVolume() {
  try { return game.settings.get("core", "globalInterfaceVolume") ?? 0.5; } catch { return 0.5; }
}

function fontList(current) {
  const base = Object.keys(CONFIG.fontDefinitions ?? {});
  const list = [...new Set([...base, ...GENERIC_FONTS])];
  if (current && !list.includes(current)) list.unshift(current);
  return list;
}

const IMAGES = new Map();
const isImageSrc = s => /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(s) || /^https?:\/\//i.test(s);
function getImage(src) {
  let e = IMAGES.get(src);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    img.onload = () => { e.ok = true; editor?._draw(); viewer?._draw(); };
    img.src = src;
    IMAGES.set(src, e);
  }
  return e.ok ? e.img : null;
}

/* ---------------- wheel data ---------------- */

function newWheel(name) {
  const th = THEMES.default;
  return {
    id: foundry.utils.randomID(),
    name,
    scope: "world",
    duration: 6,
    removeWinner: false,
    postChat: true,
    style: { ...th.style },
    effect: th.effect,
    sounds: { spin: "tick", spinFile: "", win: th.win, winFile: "" },
    segments: Array.from({ length: 6 }, (_, i) => ({
      label: `${t("Option")} ${i + 1}`,
      icon: "",
      color: th.palette[i % th.palette.length],
      weight: 1
    }))
  };
}

/** ทำความสะอาด/เติมค่าเริ่มต้นให้ข้อมูลวงล้อ (ใช้ทั้งตอนโหลด นำเข้า และรับ socket) */
function sanitizeWheel(raw, newId = false) {
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
    weight: num(s?.weight, 0, 1000, 1)
  }));
  return {
    id: !newId && typeof raw.id === "string" && raw.id ? raw.id.slice(0, 32) : foundry.utils.randomID(),
    name: String(raw.name ?? "").slice(0, 60) || "Wheel",
    scope: raw.scope === "global" ? "global" : "world",
    duration: num(raw.duration, 2, 30, 6),
    removeWinner: !!raw.removeWinner,
    postChat: raw.postChat !== false,
    style: {
      rim: hex(st.rim, D.style.rim),
      accent: hex(st.accent, D.style.accent),
      rimStyle: pick(st.rimStyle, RIMS, "plain"),
      pointer: pick(st.pointer, POINTERS, "triangle"),
      pointerColor: hex(st.pointerColor, D.style.pointerColor),
      hub: hex(st.hub, D.style.hub),
      font: String(st.font ?? D.style.font).slice(0, 60) || D.style.font,
      glow: !!st.glow
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

function applyTheme(wheel, id) {
  const th = THEMES[id];
  if (!th) return;
  wheel.style = { ...th.style };
  wheel.effect = th.effect;
  wheel.sounds.win = th.win;
  wheel.segments.forEach((s, i) => { s.color = th.palette[i % th.palette.length]; });
}

/* ---------------- storage ---------------- */

async function loadGlobal() {
  try {
    const res = await fetch(`${foundry.utils.getRoute(`${LIB_DIR}/${LIB_FILE}`)}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json();
    return (Array.isArray(json.wheels) ? json.wheels : []).map(w => ({ ...sanitizeWheel(w), scope: "global" }));
  } catch {
    return [];
  }
}

async function saveGlobal(list) {
  const FP = filePicker();
  try { await FP.createDirectory("data", LIB_DIR); } catch { /* มีอยู่แล้ว */ }
  const file = new File([JSON.stringify({ module: ID, version: 2, wheels: list }, null, 2)], LIB_FILE, { type: "application/json" });
  await FP.upload("data", LIB_DIR, file, {}, { notify: false });
}

/* ---------------- app ---------------- */

const { ApplicationV2 } = foundry.applications.api;

class SpinWheelApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["csw-app"],
    window: { icon: "fa-solid fa-dharmachakra", resizable: true },
    position: { width: 980, height: 700 }
  };

  constructor(options = {}) {
    super(options);
    this.viewer = !!options.viewer;
    this.size = SIZE;
    this.rot = 0;
    this.winIndex = -1;
    this.resultText = "";
    this.spinning = false;
    this._cancel = null;
    this._fx = null;
    this._fxRaf = null;
    this._spinSnd = null;
    this._prePos = null;
    this._open = { style: false, fx: false, data: false };
    this._saveChain = Promise.resolve();
    this._hadGlobal = false;
    this.wheels = [];
    this.wheel = this.viewer ? sanitizeWheel({ name: "" }) : null;
  }

  get title() {
    return this.wheel?.name || t("Title");
  }

  /** โหลดวงล้อของ World และของส่วนกลาง (ใช้ได้ทุก World) */
  async load() {
    const world = (game.settings.get(ID, "wheels")?.list ?? []).map(w => ({ ...sanitizeWheel(w), scope: "world" }));
    const glob = await loadGlobal();
    this._hadGlobal = glob.length > 0;
    this.wheels = [...world, ...glob];
    if (!this.wheels.length) this.wheels = [newWheel(t("DefaultName"))];
    const keep = this.wheel?.id;
    this.wheel = this.wheels.find(w => w.id === keep) ?? this.wheels[0];
  }

  /* ---------------- rendering ---------------- */

  async _renderHTML() {
    const el = document.createElement("div");
    el.className = "csw-root" + (this.viewer ? " csw-viewer" : "") + (this._prePos ? " csw-present" : "");
    el.innerHTML = `
      <div class="csw-stage">
        <div class="csw-canvas-wrap">
          <canvas class="csw-canvas"></canvas>
          <button type="button" class="csw-present-btn" data-act="present" title="${t("Present")}">
            <i class="fa-solid ${this._prePos ? "fa-compress" : "fa-expand"}"></i></button>
        </div>
        <div class="csw-result">${esc(this.resultText || "\u00a0")}</div>
        ${this.viewer ? "" : `<button type="button" class="csw-spin" data-act="spin">
          <i class="fa-solid fa-dharmachakra"></i> ${t("Spin")}</button>`}
      </div>
      ${this.viewer ? "" : this._editorHTML()}`;

    el.addEventListener("click", ev => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      if (this.viewer && btn.dataset.act !== "present") return;
      this._act(btn.dataset.act, btn);
    });
    if (!this.viewer) {
      el.addEventListener("change", ev => this._onChange(ev.target));
      el.addEventListener("toggle", ev => {
        const sec = ev.target?.dataset?.sec;
        if (sec) this._open[sec] = ev.target.open;
      }, true);
    }
    return el;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender() {
    this.canvas = this.element.querySelector(".csw-canvas");
    const wrap = this.element.querySelector(".csw-canvas-wrap");
    this._ro?.disconnect();
    this._ro = new ResizeObserver(() => this._fit(wrap));
    this._ro.observe(wrap);
    this._fit(wrap, true);
    if (this.spinning) this._setBusy(true);
    this._ensureFont();
  }

  _fit(wrap, force = false) {
    if (!this.canvas || !wrap) return;
    const s = Math.max(200, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)) || SIZE);
    if (!force && s === this.size) return;
    this.size = s;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(s * dpr);
    this.canvas.height = Math.round(s * dpr);
    this.canvas.style.width = `${s}px`;
    this.canvas.style.height = `${s}px`;
    this._draw();
  }

  _ensureFont() {
    const f = this.wheel?.style?.font;
    if (!f || !document.fonts?.load) return;
    document.fonts.load(`bold 16px ${fontStack(f)}`).then(() => this._draw()).catch(() => {});
  }

  _onClose() {
    this._cancel?.();
    cancelAnimationFrame(this._fxRaf);
    this._fx = null;
    this._ro?.disconnect();
    this._prePos = null;
  }

  _setBusy(on) {
    this.element?.querySelector(".csw-root")?.classList.toggle("csw-busy", on);
  }

  _setResult(text) {
    this.resultText = text || "";
    const el = this.element?.querySelector(".csw-result");
    if (el) el.textContent = this.resultText || "\u00a0";
  }

  _togglePresent() {
    if (this._prePos) {
      const p = this._prePos;
      this._prePos = null;
      this.setPosition(p);
    } else {
      const { left, top, width, height } = this.position;
      this._prePos = { left, top, width, height };
      this.setPosition({
        left: Math.round(window.innerWidth * 0.06),
        top: Math.round(window.innerHeight * 0.04),
        width: Math.round(window.innerWidth * 0.88),
        height: Math.round(window.innerHeight * 0.92)
      });
    }
    const root = this.element?.querySelector(".csw-root");
    root?.classList.toggle("csw-present", !!this._prePos);
    const icon = root?.querySelector(".csw-present-btn i");
    if (icon) icon.className = `fa-solid ${this._prePos ? "fa-compress" : "fa-expand"}`;
  }

  _editorHTML() {
    const w = this.wheel;
    const st = w.style;
    const so = w.sounds;
    const open = k => (this._open[k] ? "open" : "");
    const opts = (list, cur, prefix) => list
      .map(v => `<option value="${v}" ${v === cur ? "selected" : ""}>${t(`${prefix}.${v}`)}</option>`).join("");
    const col = (k, label) => `<label class="csw-col">${label}<input type="color" data-s="${k}" value="${st[k]}"></label>`;

    const wheelOpts = this.wheels
      .map(x => `<option value="${x.id}" ${x.id === w.id ? "selected" : ""}>${x.scope === "global" ? "🌐 " : ""}${esc(x.name)}</option>`)
      .join("");
    const themeOpts = `<option value="">${t("ApplyTheme")}</option>` +
      Object.keys(THEMES).map(id => `<option value="${id}">${t(`Themes.${id}`)}</option>`).join("");
    const fontOpts = fontList(st.font)
      .map(f => `<option value="${esc(f)}" ${f === st.font ? "selected" : ""}>${esc(f)}</option>`).join("");

    const rows = w.segments.map((s, i) => `
      <div class="csw-seg" data-i="${i}">
        <input type="color" data-f="color" value="${esc(s.color)}">
        <input type="text" data-f="icon" class="csw-icon" value="${esc(s.icon)}" placeholder="😀" title="${t("IconHint")}">
        <button type="button" data-act="pick-icon" title="${t("PickIcon")}"><i class="fa-solid fa-image"></i></button>
        <input type="text" data-f="label" value="${esc(s.label)}">
        <input type="number" data-f="weight" value="${s.weight}" min="0" step="0.5" title="${t("Weight")}">
        <button type="button" data-act="del-seg" title="${t("Delete")}"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("");

    return `
      <div class="csw-editor">
        <div class="csw-row">
          <select data-act="pick">${wheelOpts}</select>
          <button type="button" data-act="new-wheel" title="${t("NewWheel")}"><i class="fa-solid fa-plus"></i></button>
          <button type="button" data-act="del-wheel" title="${t("DeleteWheel")}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="csw-row"><input type="text" data-w="name" value="${esc(w.name)}"></div>
        <div class="csw-row">
          <label class="csw-col csw-grow">${t("Storage")}
            <select data-w="scope">
              <option value="world" ${w.scope === "world" ? "selected" : ""}>${t("StorageWorld")}</option>
              <option value="global" ${w.scope === "global" ? "selected" : ""}>${t("StorageGlobal")}</option>
            </select></label>
        </div>
        <div class="csw-row csw-opts">
          <label>${t("Duration")} <input type="number" data-w="duration" min="2" max="30" step="1" value="${w.duration}"></label>
          <label><input type="checkbox" data-w="removeWinner" ${w.removeWinner ? "checked" : ""}> ${t("RemoveWinner")}</label>
          <label><input type="checkbox" data-w="postChat" ${w.postChat ? "checked" : ""}> ${t("PostChat")}</label>
        </div>

        <div class="csw-segs">${rows}</div>
        <div class="csw-row">
          <button type="button" data-act="add-seg"><i class="fa-solid fa-plus"></i> ${t("AddOption")}</button>
          <button type="button" data-act="bulk"><i class="fa-solid fa-list"></i> ${t("Bulk")}</button>
        </div>

        <details data-sec="style" ${open("style")}>
          <summary>${t("SecStyle")}</summary>
          <div class="csw-box">
            <div class="csw-row"><select data-act="theme">${themeOpts}</select></div>
            <label class="csw-col">${t("Pointer")} <select data-s="pointer">${opts(POINTERS, st.pointer, "Pointers")}</select></label>
            <label class="csw-col">${t("Rim")} <select data-s="rimStyle">${opts(RIMS, st.rimStyle, "Rims")}</select></label>
            <label class="csw-col">${t("Font")} <select data-s="font">${fontOpts}</select></label>
            <div class="csw-grid">
              ${col("rim", t("ColorRim"))}${col("accent", t("ColorAccent"))}
              ${col("pointerColor", t("ColorPointer"))}${col("hub", t("ColorHub"))}
            </div>
            <label class="csw-col"><span>${t("Glow")}</span> <input type="checkbox" data-s="glow" ${st.glow ? "checked" : ""}></label>
          </div>
        </details>

        <details data-sec="fx" ${open("fx")}>
          <summary>${t("SecFx")}</summary>
          <div class="csw-box">
            <label class="csw-col">${t("Effect")} <select data-x="effect">${opts(EFFECTS, w.effect, "Effects")}</select></label>
            <label class="csw-col">${t("SpinSound")} <select data-x="spin">${opts(SPIN_SOUNDS, so.spin, "SpinSounds")}</select></label>
            <div class="csw-row">
              <input type="text" data-x="spinFile" placeholder="${t("SoundFile")}" value="${esc(so.spinFile)}">
              <button type="button" data-act="pick-audio" data-k="spinFile" title="${t("PickFile")}"><i class="fa-solid fa-music"></i></button>
            </div>
            <label class="csw-col">${t("WinSound")} <select data-x="win">${opts(WIN_SOUNDS, so.win, "WinSounds")}</select></label>
            <div class="csw-row">
              <input type="text" data-x="winFile" placeholder="${t("SoundFile")}" value="${esc(so.winFile)}">
              <button type="button" data-act="pick-audio" data-k="winFile" title="${t("PickFile")}"><i class="fa-solid fa-music"></i></button>
            </div>
            <button type="button" data-act="test-fx"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("TestFx")}</button>
          </div>
        </details>

        <details data-sec="data" ${open("data")}>
          <summary>${t("SecData")}</summary>
          <div class="csw-box">
            <div class="csw-row">
              <button type="button" data-act="import"><i class="fa-solid fa-file-import"></i> ${t("Import")}</button>
              <button type="button" data-act="export"><i class="fa-solid fa-file-export"></i> ${t("Export")}</button>
              <button type="button" data-act="export-all"><i class="fa-solid fa-boxes-stacked"></i> ${t("ExportAll")}</button>
            </div>
          </div>
        </details>
      </div>`;
  }

  /* ---------------- editor actions ---------------- */

  _save() {
    if (this.viewer) return;
    const world = this.wheels.filter(w => w.scope !== "global");
    const globals = this.wheels.filter(w => w.scope === "global");
    const jobs = [game.settings.set(ID, "wheels", { list: world })];
    if (globals.length || this._hadGlobal) {
      this._hadGlobal = globals.length > 0;
      this._saveChain = this._saveChain
        .then(() => saveGlobal(globals))
        .catch(err => {
          console.error(`${ID} | save global failed`, err);
          ui.notifications.error(t("GlobalSaveFail"));
        });
      jobs.push(this._saveChain);
    }
    return Promise.all(jobs);
  }

  async _onChange(inp) {
    if (this.spinning) return;
    const w = this.wheel;

    if (inp.dataset.act === "pick") {
      this.wheel = this.wheels.find(x => x.id === inp.value) ?? w;
      this.winIndex = -1;
      this._setResult("");
      return this.render();
    }
    if (inp.dataset.act === "theme") {
      if (!inp.value) return;
      applyTheme(w, inp.value);
      await this._save();
      return this.render();
    }
    if (inp.dataset.f) {
      const i = Number(inp.closest(".csw-seg").dataset.i);
      const f = inp.dataset.f;
      w.segments[i][f] = f === "weight" ? Math.max(0, Number(inp.value) || 0) : inp.value;
      this.winIndex = -1;
      await this._save();
      return this._draw();
    }
    if (inp.dataset.s) {
      const k = inp.dataset.s;
      w.style[k] = inp.type === "checkbox" ? inp.checked : inp.value;
      await this._save();
      if (k === "font") this._ensureFont();
      return this._draw();
    }
    if (inp.dataset.x) {
      const k = inp.dataset.x;
      if (k === "effect") w.effect = inp.value;
      else w.sounds[k] = inp.value;
      return this._save();
    }
    if (inp.dataset.w) {
      const k = inp.dataset.w;
      if (k === "name") w.name = inp.value.trim() || w.name;
      else if (k === "duration") w.duration = Math.min(30, Math.max(2, Number(inp.value) || 6));
      else if (k === "scope") w.scope = inp.value === "global" ? "global" : "world";
      else w[k] = inp.checked;
      await this._save();
      if (["name", "duration", "scope"].includes(k)) this.render();
    }
  }

  async _act(act, btn) {
    if (act === "present") return this._togglePresent();
    if (act === "spin") return this.spin();
    if (this.spinning) return;
    const segs = this.wheel.segments;

    if (act === "test-fx") {
      if (this._activeSegments().length < 1) return;
      this.winIndex = Math.max(0, this.winIndex);
      this._startFx(this.wheel.effect);
      this._playWin();
      return;
    }
    if (act === "export" || act === "export-all") {
      const list = act === "export" ? [this.wheel] : this.wheels;
      const data = { module: ID, version: 2, wheels: list };
      const name = act === "export" ? slug(this.wheel.name) : "spin-wheels";
      return foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", `${name}.json`);
    }
    if (act === "import") return this._import();
    if (act === "pick-icon" || act === "pick-audio") {
      const isIcon = act === "pick-icon";
      const i = isIcon ? Number(btn.closest(".csw-seg").dataset.i) : -1;
      const key = btn.dataset.k;
      new (filePicker())({
        type: isIcon ? "image" : "audio",
        callback: async path => {
          if (isIcon) this.wheel.segments[i].icon = path;
          else this.wheel.sounds[key] = path;
          await this._save();
          this.render();
        }
      }).render(true);
      return;
    }

    if (act === "new-wheel") {
      this.wheel = newWheel(`${t("DefaultName")} ${this.wheels.length + 1}`);
      this.wheels.push(this.wheel);
    } else if (act === "del-wheel") {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: t("DeleteWheel") },
        content: `<p>${t("DeleteConfirm", { name: esc(this.wheel.name) })}</p>`,
        rejectClose: false
      });
      if (!ok) return;
      this.wheels = this.wheels.filter(x => x !== this.wheel);
      if (!this.wheels.length) this.wheels.push(newWheel(t("DefaultName")));
      this.wheel = this.wheels[0];
    } else if (act === "add-seg") {
      const th = THEMES.default.palette;
      segs.push({ label: `${t("Option")} ${segs.length + 1}`, icon: "", color: th[segs.length % th.length], weight: 1 });
    } else if (act === "del-seg") {
      segs.splice(Number(btn.closest(".csw-seg").dataset.i), 1);
    } else if (act === "bulk") {
      const text = await foundry.applications.api.DialogV2.prompt({
        window: { title: t("Bulk") },
        content: `<p>${t("BulkHint")}</p><textarea name="list" rows="10" style="width:100%"></textarea>`,
        ok: { label: t("Add"), callback: (event, button) => button.form.elements.list.value },
        rejectClose: false
      });
      if (!text) return;
      const th = THEMES.default.palette;
      for (const line of text.split("\n")) {
        const [label, weight] = line.split("|").map(s => s.trim());
        if (!label) continue;
        segs.push({ label, icon: "", color: th[segs.length % th.length], weight: Math.max(0, Number(weight)) || 1 });
      }
    } else return;

    this.winIndex = -1;
    await this._save();
    this.render();
  }

  _import() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        const raws = Array.isArray(json.wheels) ? json.wheels : Array.isArray(json.segments) ? [json] : [];
        if (!raws.length) throw new Error("no wheels");
        const imported = raws.map(r => ({ ...sanitizeWheel(r, true), scope: "world" }));
        this.wheels.push(...imported);
        this.wheel = imported[imported.length - 1];
        await this._save();
        ui.notifications.info(t("ImportDone", { n: imported.length }));
        this.render();
      } catch (err) {
        console.error(`${ID} | import failed`, err);
        ui.notifications.error(t("ImportFail"));
      }
    };
    input.click();
  }

  /* ---------------- drawing ---------------- */

  _activeSegments() {
    return (this.wheel?.segments ?? []).filter(s => s.weight > 0);
  }

  _pointerPath(ctx, cx, shape) {
    ctx.beginPath();
    if (shape === "arrow") {
      ctx.moveTo(cx - 6, 0); ctx.lineTo(cx + 6, 0); ctx.lineTo(cx + 6, 16);
      ctx.lineTo(cx + 17, 16); ctx.lineTo(cx, 40); ctx.lineTo(cx - 17, 16); ctx.lineTo(cx - 6, 16);
    } else if (shape === "diamond") {
      ctx.moveTo(cx, 0); ctx.lineTo(cx + 13, 17); ctx.lineTo(cx, 36); ctx.lineTo(cx - 13, 17);
    } else if (shape === "flame") {
      ctx.moveTo(cx, 38);
      ctx.quadraticCurveTo(cx - 20, 16, cx - 7, 0);
      ctx.quadraticCurveTo(cx - 3, 13, cx, 8);
      ctx.quadraticCurveTo(cx + 3, 13, cx + 7, 0);
      ctx.quadraticCurveTo(cx + 20, 16, cx, 38);
    } else {
      ctx.moveTo(cx - 15, 0); ctx.lineTo(cx + 15, 0); ctx.lineTo(cx, 34);
    }
    ctx.closePath();
  }

  _draw() {
    const c = this.canvas;
    if (!c || !this.wheel) return;
    const ctx = c.getContext("2d");
    const k = (window.devicePixelRatio || 1) * this.size / SIZE;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const st = this.wheel.style;
    const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 26;
    const segs = this._activeSegments();
    const total = segs.reduce((a, s) => a + s.weight, 0);
    const font = fontStack(st.font);
    const noRim = st.rimStyle === "none";

    // พื้นหลังวงล้อ + แสงเรือง
    ctx.save();
    if (st.glow) { ctx.shadowColor = st.accent; ctx.shadowBlur = 24; }
    ctx.beginPath();
    ctx.arc(cx, cy, noRim ? R : R + RIM, 0, TAU);
    ctx.fillStyle = noRim ? "#888" : st.rim;
    ctx.fill();
    ctx.restore();

    let a = 0;
    segs.forEach((s, i) => {
      const span = (s.weight / total) * TAU;
      const start = this.rot + a - Math.PI / 2;
      const end = start + span;
      a += span;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, start, end);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = i === this.winIndex ? 6 : 2;
      ctx.strokeStyle = i === this.winIndex ? "#fff" : "rgba(255,255,255,.8)";
      ctx.stroke();

      if (i === this.winIndex && this._fx) {
        ctx.save();
        ctx.globalAlpha = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(this._fx.age * 14));
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + span / 2);
      ctx.textBaseline = "middle";
      ctx.fillStyle = luminance(s.color) > 0.55 ? "#111" : "#fff";

      // ไอคอน (อยู่ชิดขอบนอก) + ป้ายชื่อ (อยู่ถัดเข้ามา)
      let labelEdge = R - 12;
      let maxW = R * 0.74;
      const icon = String(s.icon ?? "").trim();
      if (icon) {
        const isize = Math.min(34, R * 0.2, Math.max(14, span * R * 0.38));
        const ix = R - 12 - isize / 2;
        if (isImageSrc(icon)) {
          const img = getImage(icon);
          if (img) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(ix, 0, isize / 2, 0, TAU);
            ctx.clip();
            ctx.drawImage(img, ix - isize / 2, -isize / 2, isize, isize);
            ctx.restore();
            ctx.beginPath();
            ctx.arc(ix, 0, isize / 2, 0, TAU);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(255,255,255,.9)";
            ctx.stroke();
          }
        } else {
          ctx.textAlign = "center";
          ctx.font = `${Math.round(isize * 0.9)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
          ctx.fillText(icon, ix, 0);
        }
        labelEdge -= isize + 8;
        maxW -= isize + 8;
      }

      ctx.textAlign = "right";
      let size = Math.min(22, Math.max(9, span * R * 0.5));
      ctx.font = `bold ${size}px ${font}`;
      while (ctx.measureText(s.label).width > maxW && size > 8) {
        size -= 1;
        ctx.font = `bold ${size}px ${font}`;
      }
      let label = String(s.label);
      while (ctx.measureText(label).width > maxW && label.length > 1) label = label.slice(0, -1);
      if (label !== s.label) label = label.slice(0, -1) + "…";
      ctx.fillText(label, labelEdge, 0);
      ctx.restore();
    });

    // ขอบวงล้อ
    if (noRim) {
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = st.rim;
      ctx.stroke();
    } else {
      const rr = R + RIM / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.lineWidth = RIM;
      ctx.strokeStyle = st.rim;
      ctx.stroke();
      if (st.rimStyle === "double") {
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TAU);
        ctx.lineWidth = 2;
        ctx.strokeStyle = st.accent;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, R + 1, 0, TAU);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = st.accent;
        ctx.stroke();
      } else if (st.rimStyle === "studs") {
        ctx.fillStyle = st.accent;
        for (let i = 0; i < 24; i++) {
          const ang = (i / 24) * TAU;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 2.8, 0, TAU);
          ctx.fill();
        }
      }
    }

    // แกนกลาง
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, TAU);
    ctx.fillStyle = st.hub;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = st.accent;
    ctx.stroke();

    // เข็มชี้
    this._pointerPath(ctx, cx, st.pointer);
    ctx.fillStyle = st.pointerColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();

    this._drawFx(ctx);
  }

  _indexAt(rot) {
    const segs = this._activeSegments();
    const total = segs.reduce((a, s) => a + s.weight, 0);
    const phi = (((-rot) % TAU) + TAU) % TAU;
    let a = 0;
    for (let i = 0; i < segs.length; i++) {
      a += (segs[i].weight / total) * TAU;
      if (phi < a) return i;
    }
    return segs.length - 1;
  }

  /* ---------------- effects ---------------- */

  _startFx(type) {
    cancelAnimationFrame(this._fxRaf);
    this._fx = null;
    if (!type || type === "none" || !this.canvas) return this._draw();

    const fx = { type, age: 0, last: null, dur: 3.4, parts: [], bursts: [] };
    if (type === "flash") fx.dur = 2.6;
    if (type === "confetti") {
      const cols = [...this.wheel.segments.map(s => s.color), "#ffd54f", "#ffffff"];
      for (let i = 0; i < 150; i++) {
        fx.parts.push({
          x: rand(0, SIZE), y: rand(-260, -10), vx: rand(-40, 40), vy: rand(70, 170),
          rot: rand(0, TAU), vr: rand(-8, 8), s: rand(5, 10), c: cols[i % cols.length]
        });
      }
    } else if (type === "fireworks") {
      fx.dur = 3.6;
      fx.bursts = [0, 0.6, 1.2].map(tm => ({ t: tm, x: rand(90, 330), y: rand(70, 230), done: false }));
    } else if (type === "embers") {
      fx.dur = 3.8;
      for (let i = 0; i < 110; i++) {
        fx.parts.push({
          x: rand(0, SIZE), y: rand(SIZE, SIZE + 120), vx: rand(-20, 20), vy: -rand(50, 150),
          s: rand(1.5, 4), c: EMBER_COLORS[i % EMBER_COLORS.length], ph: rand(0, TAU), age: 0, life: rand(2, 3.4)
        });
      }
    }
    this._fx = fx;

    const step = now => {
      const f = this._fx;
      if (!f) return;
      const dt = f.last == null ? 0 : Math.min(0.05, (now - f.last) / 1000);
      f.last = now;
      f.age += dt;
      this._stepFx(f, dt);
      this._draw();
      if (f.age < f.dur) this._fxRaf = requestAnimationFrame(step);
      else {
        this._fx = null;
        this._draw();
      }
    };
    this._fxRaf = requestAnimationFrame(step);
  }

  _stepFx(fx, dt) {
    if (fx.type === "confetti") {
      for (const p of fx.parts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx += Math.sin(fx.age * 3 + p.rot) * 20 * dt;
        p.rot += p.vr * dt;
      }
    } else if (fx.type === "fireworks") {
      for (const b of fx.bursts) {
        if (b.done || fx.age < b.t) continue;
        b.done = true;
        const hue = rand(0, 360);
        for (let i = 0; i < 55; i++) {
          const ang = rand(0, TAU), sp = rand(40, 150);
          fx.parts.push({
            x: b.x, y: b.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            age: 0, life: rand(0.9, 1.5), c: `hsl(${hue + rand(-20, 20)},100%,60%)`
          });
        }
      }
      for (const p of fx.parts) {
        p.age += dt;
        p.vy += 80 * dt;
        p.vx *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    } else if (fx.type === "embers") {
      for (const p of fx.parts) {
        p.age += dt;
        p.x += (p.vx + Math.sin(fx.age * 4 + p.ph) * 18) * dt;
        p.y += p.vy * dt;
      }
    }
  }

  _drawFx(ctx) {
    const fx = this._fx;
    if (!fx) return;
    ctx.save();
    if (fx.type === "confetti") {
      ctx.globalAlpha = Math.max(0, Math.min(1, (fx.dur - fx.age) / 0.6));
      for (const p of fx.parts) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.66);
        ctx.restore();
      }
    } else if (fx.type === "fireworks") {
      for (const p of fx.parts) {
        const al = 1 - p.age / p.life;
        if (al <= 0) continue;
        ctx.globalAlpha = al;
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, TAU);
        ctx.fill();
      }
    } else if (fx.type === "embers") {
      for (const p of fx.parts) {
        const al = (1 - p.age / p.life) * (0.6 + 0.4 * Math.sin(fx.age * 12 + p.ph));
        if (al <= 0) continue;
        ctx.globalAlpha = al;
        ctx.fillStyle = p.c;
        ctx.shadowColor = p.c;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ---------------- sounds ---------------- */

  _tick() {
    if (isMuted()) return;
    try {
      const ac = game.audio?.context;
      if (!ac) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      const now = ac.currentTime;
      o.type = "triangle";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.2 * interfaceVolume(), now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      o.connect(g);
      g.connect(ac.destination);
      o.start(now);
      o.stop(now + 0.07);
    } catch { /* ignore */ }
  }

  _synth(name) {
    try {
      const ac = game.audio?.context;
      const notes = SYNTH[name];
      if (!ac || !notes) return;
      const vol = interfaceVolume();
      const t0 = ac.currentTime;
      for (const n of notes) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = n.type;
        o.frequency.setValueAtTime(n.f, t0 + n.start);
        if (n.f1) o.frequency.exponentialRampToValueAtTime(n.f1, t0 + n.start + n.dur);
        g.gain.setValueAtTime(0.0001, t0 + n.start);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.gain * 0.5 * vol), t0 + n.start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
        o.connect(g);
        g.connect(ac.destination);
        o.start(t0 + n.start);
        o.stop(t0 + n.start + n.dur + 0.05);
      }
    } catch { /* ignore */ }
  }

  _playFile(src, loop) {
    try {
      return audioHelper().play({ src, volume: interfaceVolume(), loop, autoplay: true }, false);
    } catch (err) {
      console.warn(`${ID} | cannot play ${src}`, err);
    }
  }

  _playWin() {
    if (isMuted()) return;
    const so = this.wheel.sounds;
    if (so.win === "file" && so.winFile) this._playFile(so.winFile, false);
    else if (SYNTH[so.win]) this._synth(so.win);
  }

  _stopSpinSound() {
    Promise.resolve(this._spinSnd).then(s => s?.stop?.()).catch(() => {});
    this._spinSnd = null;
  }

  /* ---------------- spinning ---------------- */

  /** Animate to the result described by payload. Resolves true when finished, false if cancelled. */
  play(p) {
    return new Promise(resolve => {
      this._cancel?.();
      cancelAnimationFrame(this._fxRaf);
      this._fx = null;
      this.spinning = true;
      this.winIndex = -1;
      this._setResult("");
      this._setBusy(true);
      this._ensureFont();

      const sounds = this.wheel.sounds;
      if (!isMuted() && sounds.spin === "file" && sounds.spinFile) this._spinSnd = this._playFile(sounds.spinFile, true);

      const segs = this._activeSegments();
      const total = segs.reduce((a, s) => a + s.weight, 0);
      let a = 0;
      for (let i = 0; i < p.index; i++) a += (segs[i].weight / total) * TAU;
      const span = (segs[p.index].weight / total) * TAU;
      const target = a + span * p.offset;

      const startRot = this.rot;
      const norm = ((((-target - startRot) % TAU) + TAU) % TAU);
      const delta = norm + p.spins * TAU;
      const t0 = performance.now();
      let last = this._indexAt(this.rot);
      let raf;

      const finish = ok => {
        cancelAnimationFrame(raf);
        this._cancel = null;
        this.spinning = false;
        this._setBusy(false);
        this._stopSpinSound();
        if (ok) {
          this.rot = ((this.rot % TAU) + TAU) % TAU;
          this.winIndex = p.index;
          this._setResult(segs[p.index].label);
          this._startFx(this.wheel.effect);
          this._draw();
          this._playWin();
        }
        resolve(ok);
      };

      const step = now => {
        const k = Math.min(1, (now - t0) / p.duration);
        const e = 1 - Math.pow(1 - k, 4);
        this.rot = startRot + delta * e;
        this._draw();
        const idx = this._indexAt(this.rot);
        if (idx !== last) {
          last = idx;
          if (sounds.spin === "tick") this._tick();
        }
        if (k < 1) raf = requestAnimationFrame(step);
        else finish(true);
      };

      this._cancel = () => finish(false);
      raf = requestAnimationFrame(step);
    });
  }

  _pickIndex(segs) {
    const total = segs.reduce((a, s) => a + s.weight, 0);
    let r = uniform() * total;
    for (let i = 0; i < segs.length; i++) {
      r -= segs[i].weight;
      if (r < 0) return i;
    }
    return segs.length - 1;
  }

  async spin() {
    if (this.viewer || this.spinning) return;
    const segs = this._activeSegments();
    if (segs.length < 2) return ui.notifications.warn(t("NeedTwo"));

    const w = this.wheel;
    const payload = {
      name: w.name,
      segments: segs.map(s => ({ label: s.label, icon: s.icon, color: s.color, weight: s.weight })),
      style: { ...w.style },
      effect: w.effect,
      sounds: { ...w.sounds },
      index: this._pickIndex(segs),
      offset: 0.1 + uniform() * 0.8,
      spins: 5 + Math.floor(uniform() * 3),
      duration: w.duration * 1000
    };
    const winner = segs[payload.index];

    game.socket.emit(`module.${ID}`, { type: "spin", payload });
    const ok = await this.play(payload);
    if (!ok) return;

    if (w.postChat) {
      const icon = winner.icon && !isImageSrc(winner.icon) ? `${esc(winner.icon)} ` : "";
      ChatMessage.create({
        speaker: { alias: w.name },
        content: `<div class="csw-chat"><div class="csw-chat-title">${esc(w.name)}</div>
          <div class="csw-chat-result">${icon}${esc(winner.label)}</div></div>`
      });
    }
    if (w.removeWinner) {
      const i = w.segments.indexOf(winner);
      if (i >= 0) {
        w.segments.splice(i, 1);
        this.winIndex = -1;
        await this._save();
        this.render();
      }
    }
  }
}

/* ---------------- wiring ---------------- */

async function openEditor() {
  editor ??= new SpinWheelApp({ id: "csw-editor" });
  if (!editor.spinning) await editor.load();
  return editor.render({ force: true });
}

async function showViewer(p) {
  try {
    const w = sanitizeWheel({ name: p?.name, segments: p?.segments, style: p?.style, effect: p?.effect, sounds: p?.sounds });
    const active = w.segments.filter(s => s.weight > 0);
    if (active.length < 2) return;
    const clamp = (v, min, max, d) => {
      v = Number(v);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
    };
    const payload = {
      index: Math.floor(clamp(p.index, 0, active.length - 1, 0)),
      offset: clamp(p.offset, 0, 1, 0.5),
      spins: Math.floor(clamp(p.spins, 3, 12, 5)),
      duration: clamp(p.duration, 1000, 30000, 6000)
    };
    viewer ??= new SpinWheelApp({ id: "csw-viewer", viewer: true, position: { width: 640, height: 680 } });
    viewer._cancel?.();
    viewer.wheel = w;
    await viewer.render({ force: true });
    await viewer.play(payload);
  } catch (err) {
    console.error(`${ID} | viewer error`, err);
  }
}

Hooks.once("init", () => {
  game.settings.register(ID, "wheels", {
    scope: "world",
    config: false,
    type: Object,
    default: { list: [] }
  });
  game.settings.register(ID, "mute", {
    name: "CSW.SettingMute",
    hint: "CSW.SettingMuteHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.cswOpen = {
    name: "cswOpen",
    title: "CSW.ButtonTitle",
    icon: "fa-solid fa-dharmachakra",
    order: 50,
    button: true,
    visible: true,
    onChange: () => openEditor()
  };
});

Hooks.once("ready", () => {
  game.socket.on(`module.${ID}`, msg => {
    if (msg?.type === "spin") showViewer(msg.payload);
  });

  game.modules.get(ID).api = {
    open: openEditor,
    /** หมุนวงล้อตามชื่อ (เฉพาะ GM) เช่น api.spin("ของรางวัล") */
    spin: async name => {
      if (!game.user.isGM) return;
      await openEditor();
      if (name) {
        const w = editor.wheels.find(x => x.name.toLowerCase() === String(name).toLowerCase());
        if (!w) return ui.notifications.warn(`Wheel "${name}" not found`);
        editor.wheel = w;
        await editor.render({ force: true });
      }
      return editor.spin();
    }
  };
});
