/**
 * Custom Spin Wheel v2.0 - Foundry VTT v13
 *
 * - GM กดปุ่มวงล้อใน Token Controls เพื่อแก้ไข/หมุน
 * - ผู้เล่นเปิดหน้าต่างผู้เล่น เลือกวงล้อที่ GM เปิดให้ แล้วกด Spin
 *   (ผู้เล่นแค่ "ขอหมุน" เครื่อง GM เป็นคนตรวจเงื่อนไข หักเหรียญ สุ่มผล แล้วส่งให้ทุกเครื่อง)
 * - สกุลเงิน (เช่น Hell Coin) เป็นฟีเจอร์เสริม เปิด/ปิดและเปลี่ยนชื่อได้
 * - Macro: game.modules.get("custom-spin-wheel").api.spin("ชื่อวงล้อ")
 *          game.modules.get("custom-spin-wheel").api.pool.add(5, "เหตุผล")
 */

import {
  ID, DEFAULT_CURRENCY, bridge, t, esc, uniform, iconHTML, isImageSrc,
  sanitizeWheel, sanitizeCurrency, sanitizePool
} from "./data.js";
import { SpinWheelApp } from "./app.js";

let editor = null;
let viewer = null;
let spinLock = false;

/* ---------------- ข้อมูลจากการตั้งค่า ---------------- */

const worldWheelsRaw = () => foundry.utils.deepClone(game.settings.get(ID, "wheels")?.list ?? []);
const worldWheels = () => worldWheelsRaw().map(w => ({ ...sanitizeWheel(w), scope: "world" }));

bridge.currency = () => sanitizeCurrency(game.settings.get(ID, "currency"));
bridge.pool = () => sanitizePool(game.settings.get(ID, "pool"));
bridge.playerWheels = () => worldWheels().filter(w => w.playerSpin);
bridge.saveCurrency = cfg => game.settings.set(ID, "currency", sanitizeCurrency(cfg));
bridge.redrawAll = () => {
  editor?._draw();
  viewer?._draw();
};

/* ---------------- Pool ---------------- */

/** เพิ่ม/ลดยอด Pool (เรียกจากเครื่อง GM เท่านั้น) คืน false ถ้ายอดไม่พอ */
async function adjustPool(delta, why = "", who = "", { announce = false } = {}) {
  delta = Math.trunc(Number(delta));
  if (!delta) return false;
  const pool = bridge.pool();
  const next = pool.balance + delta;
  if (next < 0) return false;
  pool.balance = Math.min(999999999, next);
  pool.log.unshift({ t: Date.now(), who: String(who).slice(0, 40), d: delta, why: String(why).slice(0, 80) });
  pool.log = pool.log.slice(0, 50);
  await game.settings.set(ID, "pool", pool);

  const cur = bridge.currency();
  if (announce && cur.enabled && cur.announce) {
    ChatMessage.create({
      speaker: { alias: cur.name },
      content: `<div class="csw-chat"><div class="csw-chat-title">${esc(cur.name)}</div>
        <div class="csw-chat-result">${delta > 0 ? "+" : ""}${delta} ${iconHTML(cur.icon, "csw-coin-s")}</div>
        ${why ? `<div class="csw-chat-sub">${esc(why)}</div>` : ""}</div>`
    });
  }
  return true;
}
bridge.adjustPool = adjustPool;

/* ---------------- การหมุน (ฝั่ง GM) ---------------- */

function pickIndex(segs) {
  const total = segs.reduce((a, s) => a + s.weight, 0);
  let r = uniform() * total;
  for (let i = 0; i < segs.length; i++) {
    r -= segs[i].weight;
    if (r < 0) return i;
  }
  return segs.length - 1;
}

/** บันทึกวงล้อที่ถูกแก้ (เช่น ลบช่องที่สุ่มได้ออก) */
async function persistWheel(wheel, app) {
  if (app) {
    await app._save();
    app.render();
    return;
  }
  const list = worldWheelsRaw();
  const i = list.findIndex(w => w.id === wheel.id);
  if (i >= 0) {
    list[i] = wheel;
    await game.settings.set(ID, "wheels", { list });
  }
  if (editor?.rendered) {
    await editor.load();
    editor.render();
  }
}

/**
 * หมุนวงล้อ (ทำงานบนเครื่อง GM เท่านั้น)
 * คืน true = หมุนสำเร็จ, "funds" = เหรียญไม่พอ, false = ไม่ได้หมุน
 */
async function executeSpin({ wheel, user, cost = 0, app = null }) {
  if (spinLock) {
    ui.notifications.warn(t("Reject.busy"));
    return false;
  }
  const segs = wheel.segments.filter(s => s.weight > 0);
  if (segs.length < 2) {
    ui.notifications.warn(t("NeedTwo"));
    return false;
  }

  spinLock = true;
  try {
    const cur = bridge.currency();
    const pay = cur.enabled ? cost : 0;
    if (pay > 0 && !(await adjustPool(-pay, wheel.name, user.name))) return "funds";

    const payload = {
      wheelId: wheel.id,
      name: wheel.name,
      by: user.name,
      cost: pay,
      segments: segs.map(s => ({ label: s.label, icon: s.icon, color: s.color, weight: s.weight, rarity: s.rarity })),
      style: { ...wheel.style },
      effect: wheel.effect,
      sounds: { ...wheel.sounds },
      index: pickIndex(segs),
      offset: 0.1 + uniform() * 0.8,
      spins: 5 + Math.floor(uniform() * 3),
      duration: wheel.duration * 1000
    };
    const winner = segs[payload.index];

    game.socket.emit(`module.${ID}`, { type: "spin", payload });
    const ok = app ? await app.play(payload) : await showViewer(payload);
    if (!ok) return false;

    if (wheel.postChat) {
      const rarity = winner.rarity !== "common" ? `<div class="csw-chat-rarity csw-r-${winner.rarity}">${t(`Rarities.${winner.rarity}`)}</div>` : "";
      const sub = pay > 0
        ? `${esc(user.name)} · −${pay} ${iconHTML(cur.icon, "csw-coin-s")} ${esc(cur.name)}`
        : esc(user.name);
      const icon = winner.icon && !isImageSrc(winner.icon) ? `${esc(winner.icon)} ` : "";
      ChatMessage.create({
        speaker: { alias: wheel.name },
        content: `<div class="csw-chat"><div class="csw-chat-title">${esc(wheel.name)}</div>
          <div class="csw-chat-sub">${sub}</div>
          <div class="csw-chat-result">${icon}${esc(winner.label)}</div>${rarity}</div>`
      });
    }

    if (wheel.removeWinner) {
      const i = wheel.segments.indexOf(winner);
      if (i >= 0) {
        wheel.segments.splice(i, 1);
        await persistWheel(wheel, app);
      }
    }
    return true;
  } finally {
    spinLock = false;
  }
}
bridge.executeSpin = executeSpin;

/* ---------------- คำขอหมุนจากผู้เล่น ---------------- */

function notifyReject(reason) {
  const cur = bridge.currency();
  const key = ["nogm", "busy", "closed", "funds"].includes(reason) ? reason : "closed";
  ui.notifications.warn(t(`Reject.${key}`, { name: cur.name }));
}

function sendReject(userId, reason) {
  if (userId === game.user.id) notifyReject(reason);
  else game.socket.emit(`module.${ID}`, { type: "reject", userId, reason });
}

/** เครื่อง GM ที่เป็น activeGM เท่านั้นที่ตัดสินคำขอ */
async function handleRequest({ wheelId, userId, local = false } = {}) {
  if (!game.users.activeGM?.isSelf) return;
  const user = game.users.get(userId);
  if (!user?.active) return;

  // GM ที่กดจากเครื่องตัวเอง (local) หมุนฟรี; คำขอที่มาทาง socket ต้องจ่ายเสมอ (กันการสวมรอย userId ของ GM)
  const isLocalGM = local && userId === game.user.id && user.isGM;
  const wheel = worldWheels().find(w => w.id === wheelId);
  if (!wheel || (!wheel.playerSpin && !isLocalGM)) return sendReject(userId, "closed");
  if (spinLock) return sendReject(userId, "busy");

  const cur = bridge.currency();
  const cost = cur.enabled && !isLocalGM ? wheel.cost : 0;
  if (cost > bridge.pool().balance) return sendReject(userId, "funds");

  const result = await executeSpin({ wheel, user, cost });
  if (result === "funds") sendReject(userId, "funds");
}

/** ฝั่งผู้เล่น: ส่งคำขอหมุน */
function requestSpin(wheelId) {
  const gm = game.users.activeGM;
  if (!gm) return notifyReject("nogm");
  if (gm.isSelf) return handleRequest({ wheelId, userId: game.user.id, local: true });
  game.socket.emit(`module.${ID}`, { type: "request", wheelId, userId: game.user.id });
}
bridge.requestSpin = requestSpin;

/* ---------------- หน้าต่าง ---------------- */

async function openEditor() {
  editor ??= new SpinWheelApp({ id: "csw-editor", mode: "editor" });
  if (!editor.spinning) await editor.load();
  return editor.render({ force: true });
}

async function openPlayer() {
  viewer ??= new SpinWheelApp({ id: "csw-viewer", mode: "player", position: { width: 920, height: 660 } });
  viewer.initPlayer();
  return viewer.render({ force: true });
}

/** แสดงการหมุนที่ได้รับจาก GM (ทุกเครื่อง) คืน true เมื่อจบการหมุน */
async function showViewer(p) {
  try {
    const w = sanitizeWheel({
      id: p?.wheelId, name: p?.name, segments: p?.segments, style: p?.style, effect: p?.effect, sounds: p?.sounds
    });
    const active = w.segments.filter(s => s.weight > 0);
    if (active.length < 2) return false;
    const clamp = (v, min, max, d) => {
      v = Number(v);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
    };
    const payload = {
      index: Math.floor(clamp(p.index, 0, active.length - 1, 0)),
      offset: clamp(p.offset, 0, 1, 0.5),
      spins: Math.floor(clamp(p.spins, 3, 12, 5)),
      duration: clamp(p.duration, 1000, 30000, 6000),
      cost: Math.floor(clamp(p.cost, 0, 9999, 0))
    };
    viewer ??= new SpinWheelApp({ id: "csw-viewer", mode: "player", position: { width: 920, height: 660 } });
    viewer._cancel?.();
    viewer.playerWheels = bridge.playerWheels();
    viewer.selectedId = w.id;
    viewer.wheel = w;
    await viewer.render({ force: true });
    return await viewer.play(payload);
  } catch (err) {
    console.error(`${ID} | viewer error`, err);
    return false;
  }
}

/* ---------------- hooks ---------------- */

Hooks.once("init", () => {
  const onData = () => { if (viewer?.rendered) viewer.onDataChanged(); };
  const onPool = () => {
    if (editor?.rendered) editor.onPoolChanged();
    if (viewer?.rendered) viewer.onPoolChanged();
  };

  game.settings.register(ID, "wheels", {
    scope: "world", config: false, type: Object, default: { list: [] }, onChange: onData
  });
  game.settings.register(ID, "currency", {
    scope: "world", config: false, type: Object, default: { ...DEFAULT_CURRENCY }, onChange: onData
  });
  game.settings.register(ID, "pool", {
    scope: "world", config: false, type: Object, default: { balance: 0, log: [] }, onChange: onPool
  });
  game.settings.register(ID, "mute", {
    name: "CSW.SettingMute", hint: "CSW.SettingMuteHint",
    scope: "client", config: true, type: Boolean, default: false
  });
  game.settings.register(ID, "reduceFx", {
    name: "CSW.SettingReduce", hint: "CSW.SettingReduceHint",
    scope: "client", config: true, type: Boolean, default: false
  });
});

Hooks.on("getSceneControlButtons", controls => {
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.cswOpen = {
    name: "cswOpen",
    title: "CSW.ButtonTitle",
    icon: "fa-solid fa-dharmachakra",
    order: 50,
    button: true,
    visible: true,
    onChange: () => (game.user.isGM ? openEditor() : openPlayer())
  };
  if (game.user.isGM) {
    tools.cswPlayer = {
      name: "cswPlayer",
      title: "CSW.PlayerView",
      icon: "fa-solid fa-users-viewfinder",
      order: 51,
      button: true,
      visible: true,
      onChange: () => openPlayer()
    };
  }
});

Hooks.once("ready", () => {
  game.socket.on(`module.${ID}`, msg => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "spin") showViewer(msg.payload);
    else if (msg.type === "request") handleRequest({ wheelId: msg.wheelId, userId: msg.userId });
    else if (msg.type === "reject" && msg.userId === game.user.id) notifyReject(msg.reason);
  });

  game.modules.get(ID).api = {
    open: openEditor,
    openPlayer,
    /** หมุนวงล้อตามชื่อ (เฉพาะ GM, ฟรี) เช่น api.spin("ของรางวัล") */
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
    },
    pool: {
      get: () => bridge.pool().balance,
      /** เพิ่ม/ลดเหรียญ (เฉพาะ GM) เช่น api.pool.add(5, "เหตุผล") หรือ add(-2) */
      add: (n, why = "") => (game.user.isGM ? adjustPool(n, why, game.user.name, { announce: true }) : false)
    }
  };
});
