/**
 * Custom Spin Wheel v2.0 - หน้าต่างวงล้อ (โหมด editor สำหรับ GM / โหมด player สำหรับผู้เล่น)
 */

import {
  ID, TAU, SIZE, RIM, LIB_DIR, LIB_FILE,
  POINTERS, RIMS, EFFECTS, SPIN_SOUNDS, WIN_SOUNDS, RARITIES, HUBS, FRAMES, AMBIENTS,
  GENERIC_FONTS, EMBER_COLORS, RARITY_COLORS, THEMES, SYNTH,
  bridge, t, esc, luminance, rand, fontStack, slug, isImageSrc, iconHTML,
  newWheel, sanitizeWheel, applyTheme
} from "./data.js";

const { ApplicationV2 } = foundry.applications.api;

const filePicker = () => foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
const audioHelper = () => foundry.audio?.AudioHelper ?? AudioHelper;
const isMuted = () => game.settings.get(ID, "mute");
const reduceFx = () => game.settings.get(ID, "reduceFx");

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
function getImage(src) {
  let e = IMAGES.get(src);
  if (!e) {
    const img = new Image();
    e = { img, ok: false };
    img.onload = () => { e.ok = true; bridge.redrawAll(); };
    img.src = src;
    IMAGES.set(src, e);
  }
  return e.ok ? e.img : null;
}

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
  const file = new File([JSON.stringify({ module: ID, version: 3, wheels: list }, null, 2)], LIB_FILE, { type: "application/json" });
  await FP.upload("data", LIB_DIR, file, {}, { notify: false });
}

export class SpinWheelApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["csw-app"],
    window: { icon: "fa-solid fa-dharmachakra", resizable: true },
    position: { width: 1060, height: 740 }
  };

  constructor(options = {}) {
    super(options);
    this.mode = options.mode ?? "editor";
    this.size = SIZE;
    this.rot = 0;
    this.winIndex = -1;
    this.resultText = "";
    this.spinning = false;
    this._cancel = null;
    this._fx = null;
    this._fxRaf = null;
    this._loopRaf = null;
    this._alive = false;
    this._time = 0;
    this._lightPhase = 0;
    this._amb = [];
    this._ambType = "none";
    this._spinSnd = null;
    this._prePos = null;
    this._pendingData = false;
    this._open = { style: false, fx: false, cur: false, data: false };
    this._saveChain = Promise.resolve();
    this._hadGlobal = false;
    this.wheels = [];
    this.playerWheels = [];
    this.selectedId = null;
    this.wheel = this.isEditor ? null : sanitizeWheel({ name: "" });
  }

  get isEditor() {
    return this.mode === "editor";
  }

  get title() {
    return this.wheel?.name || t("Title");
  }

  _reduce() {
    try { return reduceFx(); } catch { return false; }
  }

  /* ---------------- data ---------------- */

  async load() {
    const world = (game.settings.get(ID, "wheels")?.list ?? []).map(w => ({ ...sanitizeWheel(w), scope: "world" }));
    const glob = await loadGlobal();
    this._hadGlobal = glob.length > 0;
    this.wheels = [...world, ...glob];
    if (!this.wheels.length) this.wheels = [newWheel(t("DefaultName"))];
    const keep = this.wheel?.id;
    this.wheel = this.wheels.find(w => w.id === keep) ?? this.wheels[0];
  }

  initPlayer() {
    this.playerWheels = bridge.playerWheels();
    const sel = this.playerWheels.find(w => w.id === this.selectedId) ?? this.playerWheels[0];
    if (sel) {
      this.selectedId = sel.id;
      if (!this.spinning) this.wheel = sel;
    }
  }

  onDataChanged() {
    if (this.isEditor) return;
    if (this.spinning) { this._pendingData = true; return; }
    this._pendingData = false;
    this.playerWheels = bridge.playerWheels();
    const sel = this.playerWheels.find(w => w.id === this.selectedId);
    if (sel) this.wheel = sel;
    this.render();
  }

  onPoolChanged() {
    this._refreshPoolUI();
    this._updateSpinState();
  }

  _save() {
    if (!this.isEditor) return;
    for (const w of this.wheels) if (w.scope === "global") w.playerSpin = false;
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

  /* ---------------- rendering ---------------- */

  _poolBadgeHTML() {
    const cur = bridge.currency();
    if (!cur.enabled) return "";
    const bal = bridge.pool().balance;
    return `<div class="csw-pool" title="${esc(cur.name)}">${iconHTML(cur.icon, "csw-coin")}
      <span class="csw-pool-balance" data-v="${bal}">${bal}</span>
      <span class="csw-pool-name">${esc(cur.name)}</span></div>`;
  }

  async _renderHTML() {
    if (!this.wheel) this.wheel = newWheel(t("DefaultName"));
    const el = document.createElement("div");
    el.className = "csw-root" + (this.isEditor ? "" : " csw-player") + (this._prePos ? " csw-present" : "");
    el.innerHTML = `
      <div class="csw-stage">
        <div class="csw-canvas-wrap">
          <canvas class="csw-canvas"></canvas>
          ${this._poolBadgeHTML()}
          <button type="button" class="csw-present-btn" data-act="present" title="${t("Present")}">
            <i class="fa-solid ${this._prePos ? "fa-compress" : "fa-expand"}"></i></button>
        </div>
        <div class="csw-result">${esc(this.resultText || " ")}</div>
        <button type="button" class="csw-spin" data-act="spin"><i class="fa-solid fa-dharmachakra"></i> ${t("Spin")}</button>
      </div>
      ${this.isEditor ? this._editorHTML() : this._playerHTML()}`;

    el.addEventListener("click", ev => {
      const btn = ev.target.closest("button[data-act]");
      if (btn) this._act(btn.dataset.act, btn);
    });
    if (this.isEditor) {
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
    if (wrap) {
      this._ro = new ResizeObserver(() => this._fit(wrap));
      this._ro.observe(wrap);
      this._fit(wrap, true);
    }
    this._alive = true;
    this._startLoop();
    if (this.spinning) this._setBusy(true);
    this._applyFrame();
    this._ensureFont();
    this._updateSpinState();
  }

  _onClose() {
    this._alive = false;
    this._cancel?.();
    cancelAnimationFrame(this._fxRaf);
    cancelAnimationFrame(this._loopRaf);
    this._loopRaf = null;
    this._fx = null;
    this._ro?.disconnect();
    this._prePos = null;
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

  _applyFrame() {
    const stage = this.element?.querySelector(".csw-stage");
    if (!stage || !this.wheel) return;
    for (const f of FRAMES) {
      if (f === "none") continue;
      stage.classList.toggle(`csw-frame-${f}`, this.wheel.style.frame === f);
    }
  }

  _setBusy(on) {
    this.element?.querySelector(".csw-root")?.classList.toggle("csw-busy", on);
  }

  _setResult(text) {
    this.resultText = text || "";
    const el = this.element?.querySelector(".csw-result");
    if (el) el.textContent = this.resultText || " ";
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

  /* ---------------- pool UI ---------------- */

  _logHTML(pool) {
    return pool.log.map(e => `<li><span class="csw-log-d ${e.d > 0 ? "pos" : "neg"}">${e.d > 0 ? "+" : ""}${e.d}</span>
      <span class="csw-log-who">${esc(e.who)}</span>
      <span class="csw-log-why">${esc(e.why)}</span></li>`).join("");
  }

  _setPool(value) {
    const el = this.element?.querySelector(".csw-pool-balance");
    if (!el) return;
    const from = Number(el.dataset.v);
    el.dataset.v = String(value);
    if (this._reduce() || !Number.isFinite(from) || from === value) {
      el.textContent = value;
      return;
    }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / 500);
      el.textContent = Math.round(from + (value - from) * k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _refreshPoolUI() {
    if (!this.element) return;
    const pool = bridge.pool();
    this._setPool(pool.balance);
    const big = this.element.querySelector(".csw-pool-big");
    if (big) big.textContent = pool.balance;
    const log = this.element.querySelector(".csw-log");
    if (log) log.innerHTML = this._logHTML(pool);
  }

  _flyCoins(n) {
    if (this._reduce() || !this.element) return;
    const root = this.element.querySelector(".csw-root");
    const badge = root?.querySelector(".csw-pool");
    const wrap = root?.querySelector(".csw-canvas-wrap");
    if (!root || !badge || !wrap) return;
    const rr = root.getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const x0 = b.left - rr.left + b.width / 2;
    const y0 = b.top - rr.top + b.height / 2;
    const x1 = w.left - rr.left + w.width / 2;
    const y1 = w.top - rr.top + w.height / 2;
    const cur = bridge.currency();
    for (let i = 0; i < Math.min(6, n); i++) {
      const el = document.createElement("span");
      el.className = "csw-fly";
      el.innerHTML = iconHTML(cur.icon, "csw-coin-fly");
      root.append(el);
      const anim = el.animate([
        { transform: `translate(${x0}px,${y0}px) scale(1)`, opacity: 1 },
        { transform: `translate(${x1}px,${y1}px) scale(0.4)`, opacity: 0 }
      ], { duration: 750, delay: i * 90, easing: "ease-in", fill: "both" });
      anim.onfinish = () => el.remove();
    }
  }

  /* ---------------- player UI ---------------- */

  _playerHTML() {
    const cur = bridge.currency();
    const items = this.playerWheels.map(w => `
      <button type="button" class="csw-wl ${w.id === this.selectedId ? "active" : ""}" data-act="choose" data-id="${esc(w.id)}">
        <span class="csw-wl-name">${esc(w.name)}</span>
        <span class="csw-wl-cost">${cur.enabled && w.cost > 0 ? `${iconHTML(cur.icon, "csw-coin-s")} ${w.cost}` : t("Free")}</span>
      </button>`).join("");
    return `<div class="csw-side">
      <div class="csw-side-title">${t("PlayerWheels")}</div>
      ${items || `<div class="csw-empty">${t("NoPlayerWheels")}</div>`}
    </div>`;
  }

  _choose(id) {
    if (this.spinning) return;
    const w = this.playerWheels.find(x => x.id === id);
    if (!w) return;
    this.selectedId = id;
    this.wheel = w;
    this.winIndex = -1;
    this._setResult("");
    this.render();
  }

  _requestSpin() {
    if (this.spinning || !this.selectedId) return;
    bridge.requestSpin(this.selectedId);
  }

  _updateSpinState() {
    const btn = this.element?.querySelector(".csw-spin");
    if (!btn || this.isEditor) return;
    const cur = bridge.currency();
    const w = this.playerWheels.find(x => x.id === this.selectedId);
    let reason = "";
    if (!w) reason = t("Reject.closed");
    else if (this.spinning) reason = t("Reject.busy");
    else if (!game.users?.activeGM) reason = t("Reject.nogm");
    else if (cur.enabled && w.cost > bridge.pool().balance) reason = t("Reject.funds", { name: cur.name });
    btn.disabled = !!reason;
    btn.title = reason;
    const cost = w && cur.enabled ? w.cost : 0;
    const coin = isImageSrc(cur.icon) ? cur.name : cur.icon;
    btn.innerHTML = `<i class="fa-solid fa-dharmachakra"></i> ${t("Spin")}${cost > 0 ? ` · ${cost} ${esc(coin)}` : ""}`;
  }

  /* ---------------- editor UI ---------------- */

  _editorHTML() {
    const w = this.wheel;
    const st = w.style;
    const so = w.sounds;
    const cur = bridge.currency();
    const pool = bridge.pool();
    const open = k => (this._open[k] ? "open" : "");
    const opts = (list, curVal, prefix) => list
      .map(v => `<option value="${v}" ${v === curVal ? "selected" : ""}>${t(`${prefix}.${v}`)}</option>`).join("");
    const col = (k, label) => `<label class="csw-col">${label}<input type="color" data-s="${k}" value="${st[k]}"></label>`;
    const chk = (k, label) => `<label class="csw-col"><span>${label}</span><input type="checkbox" data-s="${k}" ${st[k] ? "checked" : ""}></label>`;

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
        <select data-f="rarity" class="csw-rar csw-r-${s.rarity}" title="${t("Rarity")}">${opts(RARITIES, s.rarity, "Rarities")}</select>
        <button type="button" data-act="del-seg" title="${t("Delete")}"><i class="fa-solid fa-xmark"></i></button>
      </div>`).join("");

    const poolControls = cur.enabled ? `
      <div class="csw-poolbox">
        <div class="csw-pool-line">${t("PoolBalance")}: <b class="csw-pool-big">${pool.balance}</b> ${esc(cur.name)}</div>
        <div class="csw-row">
          ${[1, 5, 10, -1, -5].map(d => `<button type="button" data-act="pool-quick" data-d="${d}">${d > 0 ? "+" : ""}${d}</button>`).join("")}
        </div>
        <div class="csw-row">
          <input type="number" class="csw-pool-amt" min="1" step="1" value="1" style="flex:0 0 64px">
          <input type="text" class="csw-pool-why" placeholder="${t("PoolReason")}">
          <button type="button" data-act="pool-add" title="${t("PoolAdd")}"><i class="fa-solid fa-plus"></i></button>
          <button type="button" data-act="pool-sub" title="${t("PoolSub")}"><i class="fa-solid fa-minus"></i></button>
        </div>
        <ul class="csw-log">${this._logHTML(pool)}</ul>
      </div>` : "";

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
          <label title="${t("CostHint")}">${t("Cost")} <input type="number" data-w="cost" min="0" max="9999" step="1" value="${w.cost}" ${cur.enabled ? "" : "disabled"}></label>
          <label title="${w.scope === "global" ? t("PlayerSpinHint") : ""}"><input type="checkbox" data-w="playerSpin" ${w.playerSpin ? "checked" : ""} ${w.scope === "global" ? "disabled" : ""}> ${t("PlayerSpin")}</label>
          <label><input type="checkbox" data-w="removeWinner" ${w.removeWinner ? "checked" : ""}> ${t("RemoveWinner")}</label>
          <label><input type="checkbox" data-w="postChat" ${w.postChat ? "checked" : ""}> ${t("PostChat")}</label>
        </div>

        <div class="csw-segs">${rows}</div>
        <div class="csw-row">
          <button type="button" data-act="add-seg"><i class="fa-solid fa-plus"></i> ${t("AddOption")}</button>
          <button type="button" data-act="bulk"><i class="fa-solid fa-list"></i> ${t("Bulk")}</button>
        </div>

        <details data-sec="cur" ${open("cur")}>
          <summary>${t("SecCurrency")}</summary>
          <div class="csw-box">
            <label class="csw-col"><span>${t("CurEnable")}</span> <input type="checkbox" data-c="enabled" ${cur.enabled ? "checked" : ""}></label>
            <label class="csw-col">${t("CurName")} <input type="text" data-c="name" value="${esc(cur.name)}" maxlength="30"></label>
            <div class="csw-row">
              <input type="text" data-c="icon" value="${esc(cur.icon)}" placeholder="${t("CurIcon")}" title="${t("IconHint")}">
              <button type="button" data-act="pick-cur-icon" title="${t("PickIcon")}"><i class="fa-solid fa-image"></i></button>
            </div>
            <label class="csw-col"><span>${t("CurAnnounce")}</span> <input type="checkbox" data-c="announce" ${cur.announce ? "checked" : ""}></label>
            ${poolControls}
          </div>
        </details>

        <details data-sec="style" ${open("style")}>
          <summary>${t("SecStyle")}</summary>
          <div class="csw-box">
            <div class="csw-row"><select data-act="theme">${themeOpts}</select></div>
            <label class="csw-col">${t("Pointer")} <select data-s="pointer">${opts(POINTERS, st.pointer, "Pointers")}</select></label>
            <label class="csw-col">${t("Rim")} <select data-s="rimStyle">${opts(RIMS, st.rimStyle, "Rims")}</select></label>
            <label class="csw-col">${t("Hub")} <select data-s="hubStyle">${opts(HUBS, st.hubStyle, "Hubs")}</select></label>
            <label class="csw-col">${t("Font")} <select data-s="font">${fontOpts}</select></label>
            <label class="csw-col">${t("Frame")} <select data-s="frame">${opts(FRAMES, st.frame, "Frames")}</select></label>
            <label class="csw-col">${t("Ambient")} <select data-s="ambient">${opts(AMBIENTS, st.ambient, "Ambients")}</select></label>
            <div class="csw-grid">
              ${col("rim", t("ColorRim"))}${col("accent", t("ColorAccent"))}
              ${col("pointerColor", t("ColorPointer"))}${col("hub", t("ColorHub"))}
            </div>
            ${chk("glow", t("Glow"))}${chk("shade", t("Shade"))}${chk("metal", t("Metal"))}${chk("lights", t("Lights"))}
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
    if (inp.dataset.c) {
      const cur = { ...bridge.currency() };
      cur[inp.dataset.c] = inp.type === "checkbox" ? inp.checked : inp.value;
      await bridge.saveCurrency(cur);
      return this.render();
    }
    if (inp.dataset.f) {
      const i = Number(inp.closest(".csw-seg").dataset.i);
      const f = inp.dataset.f;
      w.segments[i][f] = f === "weight" ? Math.max(0, Number(inp.value) || 0) : inp.value;
      this.winIndex = -1;
      await this._save();
      if (f === "rarity") inp.className = `csw-rar csw-r-${inp.value}`;
      return this._draw();
    }
    if (inp.dataset.s) {
      const k = inp.dataset.s;
      w.style[k] = inp.type === "checkbox" ? inp.checked : inp.value;
      await this._save();
      if (k === "font") this._ensureFont();
      if (k === "frame") this._applyFrame();
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
      else if (k === "cost") w.cost = Math.round(Math.min(9999, Math.max(0, Number(inp.value) || 0)));
      else if (k === "scope") {
        w.scope = inp.value === "global" ? "global" : "world";
        if (w.scope === "global") w.playerSpin = false;
      } else w[k] = inp.checked;
      await this._save();
      if (["name", "duration", "scope"].includes(k)) this.render();
    }
  }

  async _act(act, btn) {
    if (act === "present") return this._togglePresent();
    if (act === "spin") return this.isEditor ? this.spin() : this._requestSpin();
    if (act === "choose") return this._choose(btn.dataset.id);
    if (!this.isEditor || this.spinning) return;
    const segs = this.wheel.segments;

    if (act === "pool-quick" || act === "pool-add" || act === "pool-sub") {
      const root = this.element;
      const why = root.querySelector(".csw-pool-why")?.value ?? "";
      let d;
      if (act === "pool-quick") d = Number(btn.dataset.d);
      else {
        const n = Math.floor(Math.abs(Number(root.querySelector(".csw-pool-amt")?.value) || 0));
        d = act === "pool-add" ? n : -n;
      }
      if (!d) return;
      const ok = await bridge.adjustPool(d, why, game.user.name, { announce: true });
      if (!ok) ui.notifications.warn(t("PoolNotEnough"));
      return;
    }
    if (act === "pick-cur-icon") {
      new (filePicker())({
        type: "image",
        callback: async path => {
          await bridge.saveCurrency({ ...bridge.currency(), icon: path });
          this.render();
        }
      }).render(true);
      return;
    }
    if (act === "test-fx") {
      const active = this._activeSegments();
      if (!active.length) return;
      this.winIndex = Math.min(Math.max(0, this.winIndex), active.length - 1);
      this._finishFx(active[this.winIndex]);
      return;
    }
    if (act === "export" || act === "export-all") {
      const list = act === "export" ? [this.wheel] : this.wheels;
      const data = { module: ID, version: 3, wheels: list };
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
      segs.push({ label: `${t("Option")} ${segs.length + 1}`, icon: "", color: th[segs.length % th.length], weight: 1, rarity: "common" });
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
        segs.push({ label, icon: "", color: th[segs.length % th.length], weight: Math.max(0, Number(weight)) || 1, rarity: "common" });
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
        // รองรับไฟล์จากทุกเวอร์ชัน: {wheels:[...]}, วงล้อเดี่ยว {segments:[...]}, หรืออาเรย์ของวงล้อ
        const raws = Array.isArray(json) ? json
          : Array.isArray(json?.wheels) ? json.wheels
            : Array.isArray(json?.segments) ? [json] : [];
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
    } else if (shape === "horns") {
      ctx.moveTo(cx, 38);
      ctx.quadraticCurveTo(cx - 6, 18, cx - 22, 2);
      ctx.quadraticCurveTo(cx - 4, 6, cx, 14);
      ctx.quadraticCurveTo(cx + 4, 6, cx + 22, 2);
      ctx.quadraticCurveTo(cx + 6, 18, cx, 38);
    } else {
      ctx.moveTo(cx - 15, 0); ctx.lineTo(cx + 15, 0); ctx.lineTo(cx, 34);
    }
    ctx.closePath();
  }

  _drawHub(ctx, cx, cy, st, font) {
    if (st.hubStyle === "coin") {
      const cur = bridge.currency();
      const icon = String(cur.icon ?? "").trim();
      ctx.beginPath();
      ctx.arc(cx, cy, 27, 0, TAU);
      ctx.fillStyle = st.accent;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = st.hub;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const isImg = icon && isImageSrc(icon);
      const img = isImg ? getImage(icon) : null;
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, TAU);
        ctx.clip();
        ctx.drawImage(img, cx - 18, cy - 18, 36, 36);
        ctx.restore();
      } else if (!isImg) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = st.hub;
        ctx.font = `bold 20px ${font}`;
        ctx.fillText(String(cur.name || "?").charAt(0).toUpperCase(), cx, cy + 1);
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, TAU);
      ctx.fillStyle = st.hub;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = st.accent;
      ctx.stroke();
    }
  }

  _draw() {
    const c = this.canvas;
    if (!c || !this.wheel) return;
    const ctx = c.getContext("2d");
    const k = (window.devicePixelRatio || 1) * this.size / SIZE;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const st = this.wheel.style;
    const reduce = this._reduce();
    const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 26;
    const segs = this._activeSegments();
    const total = segs.reduce((a, s) => a + s.weight, 0);
    const font = fontStack(st.font);
    const noRim = st.rimStyle === "none";

    this._drawAmbient(ctx, reduce);

    ctx.save();
    if (st.glow) { ctx.shadowColor = st.accent; ctx.shadowBlur = 24; }
    ctx.beginPath();
    ctx.arc(cx, cy, noRim ? R : R + RIM, 0, TAU);
    ctx.fillStyle = noRim ? "#888" : st.rim;
    ctx.fill();
    ctx.restore();

    const bounds = [];
    let a = 0;
    segs.forEach((s, i) => {
      const span = (s.weight / total) * TAU;
      const start = this.rot + a - Math.PI / 2;
      const end = start + span;
      a += span;
      bounds.push(start);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, start, end);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();

      if (st.shade) {
        const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
        g.addColorStop(0, "rgba(0,0,0,0.5)");
        g.addColorStop(0.55, "rgba(0,0,0,0)");
        g.addColorStop(1, "rgba(255,255,255,0.2)");
        ctx.fillStyle = g;
        ctx.fill();
      }

      ctx.lineWidth = i === this.winIndex ? 6 : 2;
      ctx.strokeStyle = i === this.winIndex ? "#fff" : (st.metal ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.8)");
      ctx.stroke();

      if (i === this.winIndex && this._fx) {
        ctx.save();
        ctx.globalAlpha = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(this._fx.age * 14));
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.restore();
      }

      if (s.rarity && s.rarity !== "common" && RARITY_COLORS[s.rarity]) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R - 4, start + 0.03, end - 0.03);
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.strokeStyle = RARITY_COLORS[s.rarity];
        if (!reduce) { ctx.shadowColor = RARITY_COLORS[s.rarity]; ctx.shadowBlur = s.rarity === "legendary" ? 12 : 6; }
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + span / 2);
      ctx.textBaseline = "middle";
      ctx.fillStyle = luminance(s.color) > 0.55 ? "#111" : "#fff";

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
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
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

    if (st.metal && segs.length > 1) {
      ctx.save();
      ctx.lineCap = "butt";
      for (const [width, color] of [[5, "rgba(0,0,0,0.5)"], [2, st.accent]]) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        for (const b of bounds) {
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(b) * R, cy + Math.sin(b) * R);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

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
        ctx.stroke();
      } else if (st.rimStyle === "studs" && !st.lights) {
        ctx.fillStyle = st.accent;
        for (let i = 0; i < 24; i++) {
          const ang = (i / 24) * TAU;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 2.8, 0, TAU);
          ctx.fill();
        }
      } else if (st.rimStyle === "spikes") {
        const rb = R + RIM;
        ctx.fillStyle = st.accent;
        for (let i = 0; i < 24; i++) {
          const ang = (i / 24) * TAU;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang - 0.075) * rb, cy + Math.sin(ang - 0.075) * rb);
          ctx.lineTo(cx + Math.cos(ang) * (rb + 11), cy + Math.sin(ang) * (rb + 11));
          ctx.lineTo(cx + Math.cos(ang + 0.075) * rb, cy + Math.sin(ang + 0.075) * rb);
          ctx.closePath();
          ctx.fill();
        }
      }
      if (st.lights) this._drawBulbs(ctx, cx, cy, rr, st);
    }

    this._drawHub(ctx, cx, cy, st, font);

    ctx.save();
    if (st.pointer === "flame" && !reduce) {
      ctx.translate(cx, 0);
      ctx.scale(1, 1 + 0.05 * Math.sin(this._time * 10));
      ctx.translate(-cx, 0);
    }
    this._pointerPath(ctx, cx, st.pointer);
    ctx.fillStyle = st.pointerColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.restore();

    this._drawFx(ctx);
  }

  _drawBulbs(ctx, cx, cy, rr, st) {
    const N = 24;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * TAU - Math.PI / 2;
      const on = this._fx
        ? (Math.floor(this._fx.age * 8) + i) % 2 === 0
        : (((i - Math.floor(this._lightPhase)) % 4) + 4) % 4 < 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 3, 0, TAU);
      if (on) {
        ctx.fillStyle = st.accent;
        if (!this._reduce()) { ctx.shadowColor = st.accent; ctx.shadowBlur = 8; }
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
      }
      ctx.fill();
      ctx.restore();
    }
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

  /* ---------------- idle loop ---------------- */

  _startLoop() {
    if (this._loopRaf) return;
    let last = null;
    let acc = 0;
    const frame = now => {
      if (!this._alive) {
        this._loopRaf = null;
        return;
      }
      const dt = last == null ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = this.wheel?.style;
      if (st && !this._reduce() && (st.lights || st.ambient !== "none" || st.pointer === "flame")) {
        this._time += dt;
        this._lightPhase += (this.spinning ? 9 : 1.2) * dt;
        this._stepAmbient(dt, st.ambient);
        acc += dt;
        if (acc >= 1 / 30 && !this.spinning && !this._fx) {
          acc = 0;
          this._draw();
        }
      }
      this._loopRaf = requestAnimationFrame(frame);
    };
    this._loopRaf = requestAnimationFrame(frame);
  }

  _initAmbient(type) {
    this._ambType = type;
    this._amb = [];
    if (type === "none") return;
    for (let i = 0; i < 36; i++) {
      this._amb.push({
        x: rand(0, SIZE), y: rand(0, SIZE), vx: rand(-6, 6),
        vy: type === "embers" ? -rand(15, 45) : rand(-8, 8),
        s: rand(1, 3.2), ph: rand(0, TAU), a: rand(0.25, 0.7)
      });
    }
  }

  _stepAmbient(dt, type) {
    if (type !== this._ambType) this._initAmbient(type);
    for (const p of this._amb) {
      p.x += (p.vx + Math.sin(this._time * 0.8 + p.ph) * 6) * dt;
      p.y += p.vy * dt;
      if (p.y < -10) p.y = SIZE + 10;
      if (p.y > SIZE + 10) p.y = -10;
      if (p.x < -10) p.x = SIZE + 10;
      if (p.x > SIZE + 10) p.x = -10;
    }
  }

  _drawAmbient(ctx, reduce) {
    if (reduce || !this._amb.length) return;
    const color = this._ambType === "embers" ? "#ff9100" : "#ff3030";
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    for (const p of this._amb) {
      ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(this._time * 2 + p.ph));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- win effects ---------------- */

  _startFx(type) {
    cancelAnimationFrame(this._fxRaf);
    this._fx = null;
    if (!type || type === "none" || !this.canvas || this._reduce()) return this._draw();

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

  _showBanner(seg) {
    if (this._reduce()) return;
    const wrap = this.element?.querySelector(".csw-canvas-wrap");
    if (!wrap) return;
    wrap.querySelector(".csw-banner")?.remove();
    const rarity = seg.rarity || "common";
    const icon = seg.icon ? iconHTML(seg.icon, isImageSrc(seg.icon) ? "csw-banner-img" : "csw-banner-icon") : "";
    const el = document.createElement("div");
    el.className = `csw-banner csw-r-${rarity}`;
    el.innerHTML = `${rarity !== "common" ? `<div class="csw-banner-rarity">${t(`Rarities.${rarity}`)}</div>` : ""}
      ${icon}<div class="csw-banner-text">${esc(seg.label)}</div>`;
    wrap.append(el);
    setTimeout(() => el.remove(), 3600);
  }

  _shake() {
    if (this._reduce()) return;
    const wrap = this.element?.querySelector(".csw-canvas-wrap");
    if (!wrap) return;
    wrap.classList.add("csw-shake");
    setTimeout(() => wrap.classList.remove("csw-shake"), 700);
  }

  /** ทุกอย่างที่เกิดตอนได้ผล: เอฟเฟกต์ แบนเนอร์ สั่นจอ เสียง */
  _finishFx(seg) {
    const big = seg.rarity === "legendary";
    this._startFx(big ? "fireworks" : this.wheel.effect);
    this._showBanner(seg);
    if (big) this._shake();
    this._draw();
    this._playWin(big);
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
    if (isMuted()) return;
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

  _playWin(big = false) {
    if (isMuted()) return;
    const so = this.wheel.sounds;
    if (so.win === "file" && so.winFile) this._playFile(so.winFile, false);
    else if (SYNTH[so.win]) this._synth(so.win);
    if (big && so.win !== "boom") this._synth("boom");
  }

  _stopSpinSound() {
    Promise.resolve(this._spinSnd).then(s => s?.stop?.()).catch(() => {});
    this._spinSnd = null;
  }

  /* ---------------- spinning ---------------- */

  /** แอนิเมชันหมุนไปยังผลตาม payload คืน true เมื่อหมุนจบ, false ถ้าถูกยกเลิก */
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
      this._updateSpinState();

      if (p.cost > 0 && bridge.currency().enabled) {
        this._synth("coin");
        this._flyCoins(p.cost);
      }

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
          this._finishFx(segs[p.index]);
        }
        this._updateSpinState();
        if (this._pendingData) this.onDataChanged();
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

  /** (editor) GM กดหมุนเอง: ฟรีเสมอ */
  async spin() {
    if (!this.isEditor || this.spinning) return;
    await bridge.executeSpin({ wheel: this.wheel, user: game.user, cost: 0, app: this });
  }
}
