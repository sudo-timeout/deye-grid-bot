// Deye Cloud → Telegram: сповіщення про світло, підсумок дня, попередження, команди /status і /today.
// Cloudflare Worker з cron-тригером. Стан зберігається в KV (пишемо лише при змінах).

const OK_CODE = "1000000";
const STALE_MS = 10 * 60_000; // скільки чекати свіжих даних, перш ніж сказати "немає даних"
const NOMINAL_V = 51.2; // для перерахунку А·год → кВт·год (LiFePO4 48 В)

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env).catch((e) => console.error("run failed:", e.stack || e)));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Вебхук Telegram (команди /status, /today)
    if (url.pathname === "/tg" && req.method === "POST") {
      if (!env.ADMIN_KEY || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.ADMIN_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const upd = await req.json().catch(() => ({}));
      ctx.waitUntil(onTelegram(env, upd).catch((e) => console.error("tg failed:", e.stack || e)));
      return new Response("ok");
    }

    // Службові ендпоінти — тільки з ?key=ADMIN_KEY
    if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      if (url.pathname === "/debug") return Response.json(await latest(env));
      if (url.pathname === "/status") return Response.json({ result: await run(env), state: await getState(env) });
      if (url.pathname === "/test") {
        await tg(env, "✅ Тест: бот працює.");
        return new Response("sent");
      }
      if (url.pathname === "/setup") return Response.json(await setupTelegram(env, url.origin));
      return new Response("ok");
    } catch (e) {
      return new Response(String(e.stack || e), { status: 500 });
    }
  },
};

// ---------------- основна логіка (cron) ----------------

async function run(env) {
  const st = await getState(env);
  const out = []; // [{text, silent}]
  let changed = false;
  const say = (text, silent = false) => out.push({ text, silent });

  let d;
  try {
    d = await latest(env);
  } catch (e) {
    console.error(e.message);
    if (!st.errSince) {
      st.errSince = Date.now();
      changed = true;
    } else if (!st.stale && Date.now() - st.errSince > STALE_MS) {
      st.stale = true;
      changed = true;
      say(`⚠️ Немає відповіді від Deye понад ${fmtDur(Date.now() - st.errSince)}.\n${e.message}`);
    }
    await finish(env, st, changed, out);
    return { error: e.message };
  }

  if (st.errSince) {
    st.errSince = null;
    changed = true;
  }

  const m = metrics(env, d);
  const age = Date.now() - m.sampleAt;

  if (age > STALE_MS) {
    if (!st.stale) {
      st.stale = true;
      changed = true;
      say(`⚠️ Інвертор не надсилає даних ${fmtDur(age)} (останні о ${fmtTime(m.sampleAt)}). Можливо, зник інтернет удома.`);
    }
    await finish(env, st, changed, out);
    return { stale: true, ageMin: Math.round(age / 60_000) };
  }

  if (st.stale) {
    st.stale = false;
    changed = true;
    say("📶 Дані від інвертора знову надходять.");
  }

  // ---- світло ----
  if (m.online !== null) {
    const status = m.online ? "up" : "down";
    if (st.grid !== status) {
      if (!st.grid) {
        say(m.online ? `🟢 Моніторинг запущено. Світло є (${fmt0(m.V)} В).${socLine(m)}` : `🔴 Моніторинг запущено. Світла немає, працюємо від акумулятора.${socLine(m)}`);
      } else if (!m.online) {
        say(`🔴 Світло зникло о ${fmtTime(m.sampleAt)}. Працюємо від акумулятора.${socLine(m)}${loadLines(env, m)}`);
      } else {
        const dur = m.sampleAt - st.since;
        addOutage(st, m.sampleAt, dur);
        let s = `🟢 Світло повернулося о ${fmtTime(m.sampleAt)} (${fmt0(m.V)} В).\nСвітла не було ${fmtDur(dur)}.`;
        if (st.socStart != null && m.soc != null) {
          s += `\n🔋 Заряд: ${fmt0(st.socStart)}% → ${fmt0(m.soc)}%`;
          if (st.socMin != null && st.socMin < m.soc) s += ` (мінімум ${fmt0(st.socMin)}%)`;
          if (m.kwh && st.socStart > m.soc) s += `\n⚡ Використано з батареї ≈ ${((st.socStart - m.soc) / 100 * m.kwh).toFixed(1)} кВт·год`;
        }
        say(s);
      }
      st.grid = status;
      st.since = m.sampleAt;
      st.socStart = m.online ? null : m.soc;
      st.socMin = m.online ? null : m.soc;
      changed = true;
    } else if (!m.online && m.soc != null && (st.socMin == null || m.soc < st.socMin)) {
      st.socMin = m.soc;
      changed = true;
    }
  }

  // ---- попередження (кожне — один раз, з гістерезисом) ----
  const flag = (name, on, off, text, silent = false) => {
    if (on && !st[name]) {
      st[name] = true;
      changed = true;
      say(text, silent);
    } else if (off && st[name]) {
      st[name] = false;
      changed = true;
    }
  };

  const socLow = Number(env.SOC_LOW || 30);
  if (m.soc != null) {
    flag("socLow", m.soc <= socLow, m.soc >= socLow + 10, `🪫 Заряд акумулятора низький: ${fmt0(m.soc)}%.${loadLines(env, m)}`);
    flag("socFull", m.soc >= 100, m.soc <= 95, "🔋 Акумулятор заряджено до 100%.", true);
  }
  if (m.online && m.V != null) {
    flag("vLow", m.V < 190, m.V >= 200, `⚠️ Низька напруга в мережі: ${fmt0(m.V)} В. Обережно з чутливою технікою.`);
    flag("vHigh", m.V > 250, m.V <= 245, `⚠️ Висока напруга в мережі: ${fmt0(m.V)} В.`);
  }
  if (m.temp != null) {
    flag("cold", m.temp <= 5, m.temp >= 8, `🥶 Батарея холодна: ${m.temp.toFixed(1)} °C. LiFePO4 погано заряджається на холоді — заряд може обмежуватися.`);
  }

  // ---- підсумок дня ----
  const now = kyiv();
  const sumHour = Number(env.SUMMARY_HOUR ?? 22);
  if (sumHour >= 0 && now.hour >= sumHour && st.summaryDate !== now.date) {
    st.summaryDate = now.date;
    changed = true;
    say(summaryText(env, st, m));
  }

  await finish(env, st, changed, out);
  return { grid: st.grid, V: m.V, F: m.F, soc: m.soc, load: m.load, temp: m.temp, sampleAt: new Date(m.sampleAt).toISOString() };
}

// ---------------- тексти ----------------

function socLine(m) {
  return m.soc != null ? `\n🔋 Заряд: ${fmt0(m.soc)}%` : "";
}

function loadLines(env, m) {
  if (m.load == null || m.load < 50) return "";
  let s = `\n⚡ Навантаження: ${(m.load / 1000).toFixed(2)} кВт`;
  const minSoc = Number(env.MIN_SOC || 20);
  if (m.kwh && m.soc != null && m.soc > minSoc) {
    const hours = (m.kwh * (m.soc - minSoc)) / 100 / (m.load / 1000);
    s += `\n⏳ Вистачить приблизно на ${fmtDur(hours * 3_600_000)} (до ${minSoc}%)`;
  }
  return s;
}

function statusText(env, st, m) {
  const age = Date.now() - m.sampleAt;
  if (age > STALE_MS) return `⚠️ Свіжих даних немає ${fmtDur(age)} (останні о ${fmtTime(m.sampleAt)}).`;
  const lines = [];
  if (m.online === false) {
    lines.push(`🔴 Світла немає${st.grid === "down" && st.since ? ` з ${fmtTime(st.since)} (вже ${fmtDur(m.sampleAt - st.since)})` : ""}`);
  } else if (m.online) {
    lines.push(`🟢 Світло є${st.grid === "up" && st.since ? ` з ${fmtTime(st.since)}` : ""} · ${fmt0(m.V)} В · ${m.F != null ? m.F.toFixed(1) : "?"} Гц`);
  }
  if (m.soc != null) {
    let s = `🔋 ${fmt0(m.soc)}%`;
    if (m.batt != null && Math.abs(m.batt) >= 30) s += m.batt > 0 ? ` · розряджається ${(m.batt / 1000).toFixed(2)} кВт` : ` · заряджається ${(-m.batt / 1000).toFixed(2)} кВт`;
    lines.push(s);
  }
  if (m.load != null) lines.push(`⚡ Навантаження: ${(m.load / 1000).toFixed(2)} кВт`);
  if (m.online === false) {
    const l = loadLines(env, m).split("\n").find((x) => x.startsWith("⏳"));
    if (l) lines.push(l);
  }
  if (m.temp != null) lines.push(`🌡 Батарея: ${m.temp.toFixed(1)} °C`);
  lines.push(`🕒 Дані о ${fmtTime(m.sampleAt)}`);
  return lines.join("\n");
}

function summaryText(env, st, m) {
  const day = st.day && st.day.date === kyiv().date ? st.day : { count: 0, ms: 0 };
  const k = (x) => (x == null ? "?" : x.toFixed(1));
  const lines = [`📊 Підсумок дня ${kyiv().date.split("-").reverse().slice(0, 2).join(".")}`];
  lines.push(`🏠 Споживання: ${k(m.dayCons)} кВт·год`);
  lines.push(`🔌 З мережі: ${k(m.dayBought)} кВт·год`);
  lines.push(`🔋 Батарея: заряджено ${k(m.dayChg)} / віддано ${k(m.dayDis)} кВт·год`);
  let out = `💡 Відключень: ${day.count}`;
  if (day.count) out += `, разом ${fmtDur(day.ms)}`;
  if (st.grid === "down" && st.since) out += `\n   зараз світла немає вже ${fmtDur(Date.now() - st.since)}`;
  lines.push(out);
  if (m.soc != null) lines.push(`🔋 Заряд зараз: ${fmt0(m.soc)}%`);
  return lines.join("\n");
}

function addOutage(st, endMs, dur) {
  const date = kyiv(endMs).date;
  if (!st.day || st.day.date !== date) st.day = { date, count: 0, ms: 0 };
  st.day.count += 1;
  st.day.ms += dur;
}

// ---------------- Telegram: команди ----------------

async function onTelegram(env, upd) {
  const msg = upd.message;
  if (!msg || !msg.text) return;
  const chat = String(msg.chat.id);
  if (!chatIds(env).includes(chat)) {
    await send(env, chat, `Це приватний бот. Ваш chat id: ${chat}`);
    return;
  }
  const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === "/status" || cmd === "/start") {
    const [st, d] = await Promise.all([getState(env), latest(env)]);
    await send(env, chat, statusText(env, st, metrics(env, d)));
  } else if (cmd === "/today") {
    const [st, d] = await Promise.all([getState(env), latest(env)]);
    await send(env, chat, summaryText(env, st, metrics(env, d)));
  } else {
    await send(env, chat, "Команди:\n/status — поточний стан\n/today — підсумок дня");
  }
}

async function setupTelegram(env, origin) {
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  };
  return {
    webhook: await call("setWebhook", { url: `${origin}/tg`, secret_token: env.ADMIN_KEY, allowed_updates: ["message"] }),
    commands: await call("setMyCommands", {
      commands: [
        { command: "status", description: "Поточний стан" },
        { command: "today", description: "Підсумок дня" },
      ],
    }),
  };
}

// ---------------- дані інвертора ----------------

function metrics(env, d) {
  const p = d.dataList || [];
  const V = pick(p, /^GridVoltage/i);
  const F = pick(p, /^GridFrequency$/i);
  const online = V === null && F === null ? null : !((F !== null && F < 40) || (V !== null && V < 100));
  const ah = pick(p, /^BatteryRatedCapacity$/i);
  const kwhEnv = Number(env.BATTERY_KWH || 0);
  return {
    sampleAt: toMs(d.collectionTime),
    V,
    F,
    online,
    soc: pick(p, /^(BMS_?)?SOC$/i) ?? pick(p, /SOC/i),
    load: pick(p, /^TotalConsumptionPower$/i) ?? pick(p, /UPS.*Power|Load.*Power|Consumption.*Power/i),
    batt: pick(p, /^BatteryPower$/i), // >0 розряд, <0 заряд
    temp: pick(p, /^BMSTemperature$/i) ?? pick(p, /^BatteryTemperature$/i),
    kwh: kwhEnv > 0 ? kwhEnv : ah ? (ah * NOMINAL_V) / 1000 : null,
    dayCons: pick(p, /^DailyConsumption$/i),
    dayBought: pick(p, /^DailyEnergyPurchased$/i),
    dayChg: pick(p, /^DailyChargingEnergy$/i),
    dayDis: pick(p, /^DailyDischargingEnergy$/i),
  };
}

// ---------------- Deye OpenAPI ----------------

async function latest(env) {
  const sn = await deviceSn(env);
  const r = await deye(env, "/device/latest", { deviceList: [sn] });
  const d = (r.deviceDataList || [])[0];
  if (!d) {
    await env.STATE.delete("sn");
    throw new Error(`Інвертора ${sn} немає у відповіді Deye`);
  }
  return d;
}

// Серійник інвертора: з DEYE_DEVICE_SN або автоматично з акаунта (перший інвертор), кешується в KV.
async function deviceSn(env) {
  if (env.DEYE_DEVICE_SN) return env.DEYE_DEVICE_SN;
  const cached = await env.STATE.get("sn");
  if (cached) return cached;
  const stations = (await deye(env, "/station/list", { page: 1, size: 200 })).stationList || [];
  for (const s of stations) {
    const r = await deye(env, "/station/device", { stationIds: [s.id], page: 1, size: 200 });
    const inv = (r.deviceListItems || []).find((x) => /inverter/i.test(x.deviceType || ""));
    if (inv) {
      await env.STATE.put("sn", inv.deviceSn);
      return inv.deviceSn;
    }
  }
  throw new Error("Не знайшов інвертор в акаунті Deye — вкажіть DEYE_DEVICE_SN вручну");
}

async function deye(env, path, body, { auth = true, query = "", retried = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = await token(env);
  const base = (env.DEYE_BASE_URL || "https://eu1-developer.deyecloud.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1.0${path}${query}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  const bad = !res.ok || json.success === false || (json.code !== undefined && String(json.code) !== OK_CODE);
  if (bad) {
    const msg = json.msg || res.statusText;
    const authErr = res.status === 401 || res.status === 403 || /token|unauthori[sz]ed|login/i.test(msg);
    if (auth && authErr && !retried) {
      await env.STATE.delete("token");
      return deye(env, path, body, { auth, query, retried: true });
    }
    throw new Error(`Deye ${path}: HTTP ${res.status}, code ${json.code}, ${msg}`);
  }
  return json;
}

async function token(env) {
  const t = await env.STATE.get("token", "json");
  if (t && t.expiresAt - 86_400_000 > Date.now()) return t.value;
  const r = await deye(
    env,
    "/account/token",
    { appSecret: env.DEYE_APP_SECRET, email: env.DEYE_EMAIL, password: await sha256(env.DEYE_PASSWORD) },
    { auth: false, query: `?appId=${encodeURIComponent(env.DEYE_APP_ID)}` },
  );
  const value = /^bearer /i.test(r.accessToken) ? r.accessToken : `Bearer ${r.accessToken}`;
  await env.STATE.put("token", JSON.stringify({ value, expiresAt: Date.now() + Number(r.expiresIn) * 1000 }));
  return value;
}

// ---------------- Telegram: відправка ----------------

function chatIds(env) {
  return String(env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function send(env, chat_id, text, silent = false) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, disable_notification: silent }),
  });
  if (!r.ok) console.error("telegram", chat_id, r.status, await r.text());
}

async function tg(env, text, silent = false) {
  for (const id of chatIds(env)) await send(env, id, text, silent);
}

async function finish(env, st, changed, out) {
  for (const o of out) await tg(env, o.text, o.silent);
  if (changed) await env.STATE.put("state", JSON.stringify(st));
}

async function getState(env) {
  return (await env.STATE.get("state", "json")) || {};
}

// ---------------- утиліти ----------------

function pick(points, re) {
  const p = points.find((x) => re.test(x.key));
  if (!p || p.value === null || p.value === undefined || p.value === "") return null;
  const n = Number(p.value);
  return Number.isFinite(n) ? n : null;
}

const toMs = (t) => {
  const n = Number(t);
  return n < 1e12 ? n * 1000 : n;
};

const fmt0 = (x) => (x == null ? "?" : Math.round(x));

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" });
}

function fmtDur(ms) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h ? `${h} год ${mins % 60} хв` : `${mins} хв`;
}

function kyiv(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24 };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
