// Deye Cloud → Telegram: сповіщення про світло, підсумок дня, попередження, команди /status і /today.
// Cloudflare Worker з cron-тригером. Стан зберігається в KV (пишемо лише при змінах).

const OK_CODE = "1000000";
const STALE_MS = 10 * 60_000; // скільки чекати свіжих даних, перш ніж сказати "немає даних"
const NOMINAL_V = 51.2; // для перерахунку А·год → кВт·год (LiFePO4 48 В)
const LOSS = 1.1; // батарея віддає ~на 10% більше, ніж споживає навантаження (втрати + власне споживання інвертора)
const AVG_MIN_MS = 15 * 60_000; // скільки триває відключення, перш ніж рахувати середнє з його початку

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
      if (url.pathname === "/schedule") return Response.json(await scheduleDebug(env));
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
    await healthPing(env, `/fail`);
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
    await healthPing(env, ""); // сам бот живий; про відсутність даних він повідомляє сам
    return { stale: true, ageMin: Math.round(age / 60_000) };
  }

  if (st.stale) {
    st.stale = false;
    changed = true;
    say("📶 Дані від інвертора знову надходять.");
  }

  // ---- середня потужність розряду під час відключення (для чесного прогнозу) ----
  if (m.online === false && st.grid === "down" && st.outLast && m.sampleAt > st.outLast) {
    const dt = m.sampleAt - st.outLast;
    if (dt < 15 * 60_000 && m.batt != null) {
      st.outE = (st.outE || 0) + Math.max(m.batt, 0) * dt;
      st.outT = (st.outT || 0) + dt;
    }
    st.outLast = m.sampleAt;
    changed = true;
  }
  Object.assign(m, powerEstimate(m, st));

  // ---- світло ----
  if (m.online !== null) {
    const status = m.online ? "up" : "down";
    if (st.grid !== status) {
      if (!st.grid) {
        say(m.online ? `🟢 Моніторинг запущено. Світло є (${fmt0(m.V)} В).${socLine(m)}` : `🔴 Моніторинг запущено. Світла немає, працюємо від акумулятора.${socLine(m)}`);
      } else if (!m.online) {
        const row = await schedule(env, true);
        say(`🔴 Світло зникло о ${fmtTime(m.sampleAt)}. Працюємо від акумулятора.${socLine(m)}${loadLines(env, m)}${scheduleOnOutage(env, row, m)}`);
      } else {
        const dur = m.sampleAt - st.since;
        addOutage(st, m.sampleAt, dur);
        let avgLine = "";
        if (st.outT >= AVG_MIN_MS && st.outE > 0) {
          st.histE = (st.histE || 0) * 0.7 + st.outE; // свіжі відключення важать більше
          st.histT = (st.histT || 0) * 0.7 + st.outT;
          avgLine = `\n📉 Середній розряд за відключення: ${kw(st.outE / st.outT)}`;
          avgLine += capacityLearn(st, m);
        }
        let s = `🟢 Світло повернулося о ${fmtTime(m.sampleAt)} (${fmt0(m.V)} В).\nСвітла не було ${fmtDur(dur)}.`;
        if (st.socStart != null && m.soc != null) {
          s += `\n🔋 Заряд: ${fmt0(st.socStart)}% → ${fmt0(m.soc)}%`;
          if (st.socMin != null && st.socMin < m.soc) s += ` (мінімум ${fmt0(st.socMin)}%)`;
          if (m.kwh && st.socStart > m.soc) s += `\n⚡ Використано з батареї ≈ ${((st.socStart - m.soc) / 100 * m.kwh).toFixed(1)} кВт·год`;
        }
        s += avgLine;
        s += scheduleOnRestore(env, await schedule(env, true));
        say(s);
      }
      st.grid = status;
      st.since = m.sampleAt;
      st.socStart = m.online ? null : m.soc;
      st.socMin = m.online ? null : m.soc;
      st.outE = 0;
      st.outT = 0;
      st.outLast = m.online ? null : m.sampleAt;
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

  // ---- графік відключень (Alerts Energy) ----
  if (scheduleEnabled(env)) {
    const row = await schedule(env);
    if (row) changed = scheduleWatch(env, st, row, m, say) || changed;
  }

  // ---- підсумок дня ----
  const now = kyiv();
  const sumHour = Number(env.SUMMARY_HOUR ?? 22);
  if (sumHour >= 0 && now.hour >= sumHour && st.summaryDate !== now.date) {
    st.summaryDate = now.date;
    changed = true;
    say(summaryText(env, st, m, scheduleEnabled(env) ? await schedule(env) : null));
  }

  await finish(env, st, changed, out);
  await healthPing(env, "");
  return { grid: st.grid, V: m.V, F: m.F, soc: m.soc, load: m.load, temp: m.temp, sampleAt: new Date(m.sampleAt).toISOString() };
}

// ---------------- тексти ----------------

function socLine(m) {
  return m.soc != null ? `\n🔋 Заряд: ${fmt0(m.soc)}%` : "";
}

// Якою потужністю (Вт, з боку батареї) рахувати прогноз. Під час відключень родина економить,
// тож рахуємо за тим, як батарея реально розряджається САМЕ під час відключень:
// 1) історія минулих відключень (зважене середнє, свіжі важать більше) + поточне, якщо воно вже довше 15 хв;
// 2) якщо історії ще немає — поточний розряд батареї (під час відключення) або поточне навантаження.
const SRC_HIST = "середній розряд під час відключень";
function powerEstimate(m, st) {
  const histE = (st && st.histE) || 0;
  const histT = (st && st.histT) || 0;
  if (st && st.grid === "down" && m.online === false) {
    const curE = st.outE || 0;
    const curT = st.outT || 0;
    if (curT >= AVG_MIN_MS && curE > 0) {
      const w = (curE + histE * 0.5) / (curT + histT * 0.5);
      return { useW: w, showW: w, useSrc: SRC_HIST };
    }
    if (histT > 0) return { useW: histE / histT, showW: histE / histT, useSrc: SRC_HIST };
    if (m.batt != null && m.batt > 50) return { useW: m.batt, showW: m.batt, useSrc: "поточний розряд" };
  }
  if (histT > 0) return { useW: histE / histT, showW: histE / histT, useSrc: SRC_HIST };
  if (m.load != null && m.load >= 50) return { useW: m.load * LOSS, showW: m.load, useSrc: "поточне навантаження" };
  return { useW: null, showW: null, useSrc: null };
}

// Скільки (мс) протримається батарея від soc до MIN_SOC при потужності w (Вт); null — якщо не порахувати
function runtimeAt(env, m, soc, w) {
  const minSoc = Number(env.MIN_SOC || 20);
  if (!m.kwh || soc == null || soc <= minSoc || !w || w < 50) return null;
  return ((m.kwh * (soc - minSoc)) / 100 / (w / 1000)) * 3_600_000;
}

function runtimeMs(env, m) {
  return runtimeAt(env, m, m.soc, m.useW ?? (m.load != null ? m.load * LOSS : null));
}

const kw = (w) => `${(w / 1000).toFixed(2)} кВт`;

// Рядки прогнозу: основний — за тим, як батарея зазвичай розряджається під час відключень,
// і, якщо суттєво відрізняється, — за поточним навантаженням.
// Як пояснити, за чим рахуємо
function srcWords(m) {
  if (m.useSrc === SRC_HIST) return `як зазвичай без світла (${kw(m.showW)})`;
  return `якщо споживати як зараз (${kw(m.showW)})`;
}

// Рядки прогнозу: коли закінчиться заряд — на годиннику і в годинах.
// Якщо світло є, прогноз умовний: «якщо світло зникне».
function runtimeLines(env, m) {
  const rt = runtimeMs(env, m);
  if (rt == null) return "";
  const pre = m.online === false ? "⏳ Вистачить" : "⏳ Якщо світло зникне — вистачить";
  let s = `\n${pre} до ${fmtEta(Date.now() + rt)} (~${fmtDur(rt)}), ${srcWords(m)}`;
  if (m.useSrc === SRC_HIST && m.load != null && m.load >= 50) {
    const now = runtimeAt(env, m, m.soc, m.load * LOSS);
    if (now != null && Math.abs(now - rt) / rt > 0.15) s += `\n   якщо споживати як зараз (${kw(m.load)}) — до ${fmtEta(Date.now() + now)} (~${fmtDur(now)})`;
  }
  return s;
}

// Скільки енергії в запасі до MIN_SOC
function reserveText(env, m) {
  const minSoc = Number(env.MIN_SOC || 20);
  if (!m.kwh || m.soc == null) return "";
  return ` · ≈${Math.max(0, ((m.soc - minSoc) / 100) * m.kwh).toFixed(1)} кВт·год у запасі`;
}

function loadLines(env, m) {
  if (m.load == null || m.load < 50) return "";
  return `\n⚡ Навантаження: ${kw(m.load)}` + runtimeLines(env, m);
}

function statusText(env, st, m, row = null) {
  const age = Date.now() - m.sampleAt;
  if (age > STALE_MS) return `⚠️ Свіжих даних немає ${fmtDur(age)} (останні о ${fmtTime(m.sampleAt)}).`;
  const lines = [];
  if (m.online === false) {
    lines.push(`🔴 Світла немає${st.grid === "down" && st.since ? ` з ${fmtTime(st.since)} (вже ${fmtDur(m.sampleAt - st.since)})` : ""}`);
  } else if (m.online) {
    lines.push(`🟢 Світло є${st.grid === "up" && st.since ? ` з ${fmtTime(st.since)}` : ""} · ${fmt0(m.V)} В · ${m.F != null ? m.F.toFixed(1) : "?"} Гц`);
  }
  if (m.soc != null) {
    let s = `🔋 ${fmt0(m.soc)}%${reserveText(env, m)}`;
    if (m.batt != null && Math.abs(m.batt) >= 30) s += m.batt > 0 ? ` · розряджається ${(m.batt / 1000).toFixed(2)} кВт` : ` · заряджається ${(-m.batt / 1000).toFixed(2)} кВт`;
    lines.push(s);
  }
  if (m.load != null) lines.push(`⚡ Навантаження: ${(m.load / 1000).toFixed(2)} кВт`);
  const rl = runtimeLines(env, m).trim();
  if (rl) lines.push(rl);
  if (m.temp != null) lines.push(`🌡 Батарея: ${m.temp.toFixed(1)} °C`);
  const sl = scheduleStatusLine(env, row, m);
  if (sl) lines.push(sl);
  lines.push(`🕒 Дані о ${fmtTime(m.sampleAt)}`);
  return lines.join("\n");
}

function summaryText(env, st, m, row = null) {
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
  const sched = row ? dayOf(row, kyiv().date) : null;
  if (sched) {
    if (sched.status === "EmergencyShutdowns") lines.push("📅 Графік: діяли аварійні відключення");
    else if (sched.status === "ScheduleApplies" && sched.slots) {
      const planned = (sched.slots.filter(Boolean).length / 2) * 3_600_000;
      const actual = day.ms + (st.grid === "down" && st.since ? Date.now() - st.since : 0);
      lines.push(`📅 За графіком без світла ${fmtDur(planned)}, фактично ${fmtDur(actual)}`);
    }
  }
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
    const [st, d, row] = await Promise.all([getState(env), latest(env), schedule(env)]);
    const m = metrics(env, d);
    Object.assign(m, powerEstimate(m, st));
    await send(env, chat, statusText(env, st, m, row));
  } else if (cmd === "/schedule" || cmd === "/grafik") {
    if (!scheduleEnabled(env)) {
      await send(env, chat, "Графіки відключень не підключені (потрібен ключ Alerts Energy, див. README).");
    } else {
      await send(env, chat, scheduleText(env, await schedule(env, true)));
    }
  } else if (cmd === "/battery") {
    const [st, d] = await Promise.all([getState(env), latest(env)]);
    await send(env, chat, batteryText(env, st, metrics(env, d)));
  } else if (cmd === "/preview") {
    if (!scheduleEnabled(env)) {
      await send(env, chat, "Графіки відключень не підключені (потрібен ключ Alerts Energy, див. README).");
    } else {
      const [st, d, row] = await Promise.all([getState(env), latest(env), schedule(env, true)]);
      const m = metrics(env, d);
      Object.assign(m, powerEstimate(m, st));
      await send(env, chat, previewText(env, row, m));
    }
  } else if (cmd === "/today") {
    const [st, d, row] = await Promise.all([getState(env), latest(env), schedule(env)]);
    await send(env, chat, summaryText(env, st, metrics(env, d), row));
  } else {
    await send(env, chat, "Команди:\n/status — поточний стан\n/today — підсумок дня\n/schedule — графік відключень на сьогодні й завтра\n/preview — що бот напише, якщо світло зникне зараз\n/battery — стан і реальна ємність батареї");
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
        { command: "schedule", description: "Графік відключень" },
        { command: "preview", description: "Перевірити прогноз за графіком" },
        { command: "battery", description: "Стан і реальна ємність батареї" },
      ],
    }),
  };
}

// ---------------- графіки відключень (Alerts Energy API, опційно) ----------------
// Формат години: 0 — світло є, 1 — відключення всю годину, 2 — перша половина, 3 — друга половина.

const AE_BASE = "https://alerts.energy/api/v1";
const SCHED_TTL_MS = 15 * 60_000; // як часто оновлювати графік
const WARN_BEFORE_MIN = 30; // попередження перед відключенням за графіком
const PREP_BEFORE_MIN = 180; // за скільки хвилин перевіряти, чи вистачить заряду на наступне відключення

const STATUS_TEXT = {
  NoShutdowns: "відключень не заплановано",
  WaitingForSchedule: "графік ще не опубліковано",
  EmergencyShutdowns: "діють аварійні відключення, графік не діє",
};

function scheduleEnabled(env) {
  return !!(env.ALERTS_ENERGY_KEY && env.SCHEDULE_AREA && env.SCHEDULE_QUEUE);
}

async function fetchSchedules(env) {
  const r = await fetch(`${AE_BASE}/source-registry/areas/${encodeURIComponent(env.SCHEDULE_AREA)}/shutdowns`, {
    headers: { Authorization: `Bearer ${env.ALERTS_ENERGY_KEY}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const hint = { 401: "невірний ключ", 403: "потрібна активна підписка", 429: "вичерпано квоту" }[r.status] || "";
    throw new Error(`Alerts Energy HTTP ${r.status} ${hint}`.trim());
  }
  return r.json();
}

function pickRow(env, rows) {
  const q = String(env.SCHEDULE_QUEUE);
  const norm = (v) => String(v || "").toLowerCase().replace(/-/g, "_");
  const sup = norm(env.SCHEDULE_SUPPLIER);
  const ofQueue = rows.filter((x) => String(x.queue) === q);
  return (sup ? ofQueue.find((x) => norm(x.initiator) === sup) : ofQueue[0]) || null;
}

// Графік моєї черги; кешується в KV на SCHED_TTL_MS. При помилці повертає останній відомий.
async function schedule(env, fresh = false) {
  if (!scheduleEnabled(env)) return null;
  const cache = await env.STATE.get("sched", "json");
  if (cache && Date.now() - cache.at < (fresh ? 5 * 60_000 : SCHED_TTL_MS)) return cache.row;
  try {
    const row = pickRow(env, await fetchSchedules(env));
    if (!row) throw new Error(`Черга ${env.SCHEDULE_QUEUE} (${env.SCHEDULE_SUPPLIER || "будь-який оператор"}) не знайдена — див. /schedule?key=…`);
    await env.STATE.put("sched", JSON.stringify({ at: Date.now(), row }));
    return row;
  } catch (e) {
    console.error("schedule:", e.message);
    return cache ? cache.row : null;
  }
}

async function scheduleDebug(env) {
  if (!scheduleEnabled(env)) return { enabled: false, need: ["ALERTS_ENERGY_KEY (secret)", "SCHEDULE_AREA", "SCHEDULE_QUEUE"] };
  const rows = await fetchSchedules(env);
  const row = pickRow(env, rows);
  return {
    enabled: true,
    area: env.SCHEDULE_AREA,
    supplier: env.SCHEDULE_SUPPLIER || null,
    queue: env.SCHEDULE_QUEUE,
    found: !!row,
    operators: [...new Set(rows.map((x) => x.initiator))],
    queues: [...new Set(rows.map((x) => x.queue))],
    row,
    text: row ? scheduleText(env, row) : null,
  };
}

// 24 години → 48 півгодинних слотів (true = відключення)
function toSlots(hours) {
  if (!Array.isArray(hours) || hours.length !== 24) return null;
  const s = [];
  for (const v of hours) s.push(v === 1 || v === 2, v === 1 || v === 3);
  return s;
}

// День графіка за датою: {status, slots} або null, якщо дані не про цей день
function dayOf(row, date) {
  if (!row) return null;
  if (row.today_date === date) return { status: row.today_status, slots: toSlots(row.today) };
  if (row.tomorrow_date === date) return { status: row.tomorrow_status, slots: toSlots(row.tomorrow) };
  return null;
}

const slotTime = (i) => (i >= 48 ? "24:00" : `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

function intervals(slots) {
  const out = [];
  for (let i = 0; i < 48; ) {
    if (!slots[i]) { i++; continue; }
    let j = i;
    while (j < 48 && slots[j]) j++;
    out.push(`${slotTime(i)}–${slotTime(j)}`);
    i = j;
  }
  return out;
}

function dayText(day) {
  if (!day) return "немає даних";
  if (day.status !== "ScheduleApplies") return STATUS_TEXT[day.status] || day.status;
  if (!day.slots) return "немає даних";
  const iv = intervals(day.slots);
  if (!iv.length) return "відключень не заплановано";
  const hours = day.slots.filter(Boolean).length / 2;
  return `${iv.join(", ")} (${String(hours).replace(".", ",")} год)`;
}

const dm = (date) => date.split("-").reverse().slice(0, 2).join(".");
const nextDate = (date) => kyiv(Date.parse(`${date}T12:00:00Z`) + 86_400_000).date;

function scheduleText(env, row) {
  if (!row) return "Не вдалося отримати графік.";
  const today = kyiv().date;
  const tomorrow = nextDate(today);
  return [
    `📅 Графік відключень, черга ${env.SCHEDULE_QUEUE}`,
    `Сьогодні (${dm(today)}): ${dayText(dayOf(row, today))}`,
    `Завтра (${dm(tomorrow)}): ${dayText(dayOf(row, tomorrow))}`,
  ].join("\n");
}

// Лінія часу сьогодні+завтра (96 слотів), null — невідомо
function timeline(row, ms) {
  const k = kyiv(ms);
  const d1 = dayOf(row, k.date);
  const d2 = dayOf(row, nextDate(k.date));
  const part = (d) => (!d ? Array(48).fill(null) : d.status === "ScheduleApplies" && d.slots ? d.slots : d.status === "NoShutdowns" ? Array(48).fill(false) : Array(48).fill(null));
  return { slots: [...part(d1), ...part(d2)], now: Math.floor(k.mins / 30), mins: k.mins, today: d1 };
}

const atLabel = (i) => (i === 48 ? "24:00" : i > 48 ? `${slotTime(i - 48)} завтра` : slotTime(i));
const slotLabel = (i) => (i >= 48 ? `завтра о ${slotTime(i - 48)}` : `о ${slotTime(i)}`);
const minsUntil = (t, i) => i * 30 - t.mins;

// Кінець поточного відключення за графіком: {at, known} або null, якщо зараз за графіком світло є.
// known=false — графік далі невідомий, тож світла не буде щонайменше до `at`.
function offEnd(t) {
  if (t.slots[t.now] !== true) return null;
  let i = t.now;
  while (i < 96 && t.slots[i] === true) i++;
  return { at: i, known: i < 96 && t.slots[i] === false };
}

// Наступний початок відключення за графіком (індекс) або null
function nextOff(t) {
  for (let i = t.now + 1; i < 96; i++) {
    if (t.slots[i] === null) return null;
    if (t.slots[i] && !t.slots[i - 1]) return i;
  }
  return null;
}

function batteryVerdict(env, m, needMs) {
  const rt = runtimeMs(env, m);
  if (rt == null) return "";
  if (rt >= needMs * 1.2) return `\n✅ Батареї має вистачити, запас ~${fmtDur(rt - needMs)}.`;
  if (rt >= needMs) return "\n⚠️ Батареї впритул — краще зменшити навантаження.";
  return `\n❌ Батареї може не вистачити: до світла ~${fmtDur(needMs)}, заряду ~на ${fmtDur(rt)}. Зменшіть навантаження.`;
}

function scheduleOnOutage(env, row, m) {
  if (!row) return "";
  const t = timeline(row, m.sampleAt);
  if (t.today && t.today.status === "EmergencyShutdowns") return "\n⚠️ Діють аварійні відключення — графік зараз не діє.";
  if (!t.today || t.today.status === "WaitingForSchedule") return "\n📅 Графік на сьогодні ще не опубліковано.";
  const end = offEnd(t);
  if (end === null) return "\n📅 За графіком зараз світло мало б бути — схоже на аварійне відключення.";
  const need = minsUntil(t, end.at) * 60_000;
  if (!end.known) {
    const rt = runtimeMs(env, m);
    const warn = rt != null && rt < need ? `\n❌ Батареї може не вистачити: заряду ~на ${fmtDur(rt)}. Зменшіть навантаження.` : "";
    return `\n📅 За графіком без світла щонайменше до ${atLabel(end.at)} (далі графіка ще немає).${warn}`;
  }
  return `\n📅 За графіком світло має з'явитися ${slotLabel(end.at)} (через ${fmtDur(need)}).${batteryVerdict(env, m, need)}`;
}

function scheduleOnRestore(env, row) {
  if (!row) return "";
  const t = timeline(row, Date.now());
  if (t.slots[t.now] === true) {
    const end = offEnd(t);
    return `\n📅 Раніше за графік — за графіком відключення тривало б${end.known ? ` до ${atLabel(end.at)}` : " далі"}.`;
  }
  const n = nextOff(t);
  return n == null ? "" : `\n📅 Наступне відключення за графіком ${slotLabel(n)}.`;
}

function scheduleStatusLine(env, row, m) {
  if (!row) return "";
  const t = timeline(row, Date.now());
  if (t.today && t.today.status !== "ScheduleApplies") return `📅 Графік: ${dayText(t.today)}`;
  if (m.online === false) {
    const end = offEnd(t);
    if (end === null) return "📅 За графіком світло мало б бути — схоже на аварійне";
    if (!end.known) return `📅 За графіком без світла щонайменше до ${atLabel(end.at)}`;
    const need = minsUntil(t, end.at) * 60_000;
    const rt = runtimeMs(env, m);
    const mark = rt == null ? "" : rt >= need ? ` · ✅ запас ~${fmtDur(rt - need)}` : ` · ❌ не вистачає ~${fmtDur(need - rt)}`;
    return `📅 За графіком світло ${slotLabel(end.at)}${mark}`;
  }
  if (t.slots[t.now] === true) {
    const end = offEnd(t);
    return `📅 За графіком зараз відключення (${end.known ? "" : "щонайменше "}до ${atLabel(end.at)}), але світло є`;
  }
  const n = nextOff(t);
  return n == null ? "📅 Найближчих відключень за графіком немає" : `📅 Наступне відключення ${slotLabel(n)}`;
}

// «Що буде, якщо…» — прогон повідомлень на реальних даних без зміни стану
function previewText(env, row, m) {
  const lines = ["🧪 Перевірка прогнозу на поточних даних (нічого не змінює)", ""];
  if (!row) return lines.concat("Графік недоступний.").join("\n");
  const off = { ...m, online: false, sampleAt: Date.now() };
  lines.push("Якщо світло зникне зараз, у повідомленні буде:" + scheduleOnOutage(env, row, off));
  const t = timeline(row, Date.now());
  const n = nextOff(t);
  if (n != null) {
    let e = n;
    while (e < 96 && t.slots[e] === true) e++;
    const known = e < 96 && t.slots[e] === false;
    lines.push("", `Наступне відключення за графіком ${slotLabel(n)}${known ? ` — до ${atLabel(e)} (${fmtDur((e - n) * 30 * 60_000)})` : ""}.`);
    if (known) lines.push("Якщо почнеться вчасно, при поточному навантаженні:" + (batteryVerdict(env, m, (e - n) * 30 * 60_000) || " (не вдалося порахувати заряд)"));
    lines.push(`Попередження «⏰ за 30 хв» прийде о ${slotTime(Math.max(n - 1, 0) % 48)}${n - 1 >= 48 ? " завтра" : ""}.`);
  } else {
    lines.push("", "Наступного відключення за графіком поки немає (або графік на завтра ще не опубліковано).");
  }
  if (m.soc != null && m.kwh) {
    const minSoc = Number(env.MIN_SOC || 20);
    const left = Math.max(0, ((m.soc - minSoc) / 100) * m.kwh);
    lines.push("", `🔋 Зараз ${fmt0(m.soc)}% (≈${left.toFixed(1)} кВт·год до ${minSoc}%)${runtimeLines(env, { ...m, online: true })}`);
    if (m.useSrc !== SRC_HIST) lines.push("Після першого відключення бот запам'ятає, як батарея розряджається, коли ви економите, і рахуватиме за цим.");
  }
  lines.push("", scheduleText(env, row));
  return lines.join("\n");
}

// Відстежує зміни графіка й попереджає перед відключенням. Повертає true, якщо змінив стан.
function scheduleWatch(env, st, row, m, say) {
  let changed = false;
  const k = kyiv();
  const silent = k.hour >= 23 || k.hour < 7;
  const sig = (date) => {
    const d = dayOf(row, date);
    return d ? `${date}|${d.status}|${d.slots ? d.slots.map(Number).join("") : ""}` : null;
  };
  const today = k.date;
  const tomorrow = nextDate(today);
  const sT = sig(today);
  const sM = sig(tomorrow);
  const prev = st.sched || {};

  if (st.sched) {
    const stOf = (sg) => (sg ? sg.split("|")[1] : null);
    const nowSt = stOf(sT);
    const wasSt = prev.today && prev.today.startsWith(today) ? stOf(prev.today) : prev.tomorrow && prev.tomorrow.startsWith(today) ? stOf(prev.tomorrow) : null;
    if (nowSt === "EmergencyShutdowns" && wasSt && wasSt !== "EmergencyShutdowns") {
      say(`🚨 Оператор оголосив аварійні відключення — графік зараз не діє. Світло можуть вимкнути будь-коли.${m.soc != null ? `\n🔋 Заряд: ${fmt0(m.soc)}%` : ""}`);
    } else if (wasSt === "EmergencyShutdowns" && nowSt && nowSt !== "EmergencyShutdowns") {
      say(`✅ Аварійні відключення скасовано. Графік на сьогодні: ${dayText(dayOf(row, today))}`, silent);
    } else if (sT && prev.today && sT !== prev.today && sT !== prev.tomorrow && prev.today.startsWith(today)) {
      // Графік на сьогодні змінився (а не просто «завтра» стало «сьогодні» опівночі)
      say(`📅 Графік на сьогодні змінився: ${dayText(dayOf(row, today))}`, silent);
    }
    // З'явився або змінився графік на завтра
    if (sM && sM !== prev.tomorrow && !sM.includes("|WaitingForSchedule|")) {
      const verb = prev.tomorrow && prev.tomorrow.startsWith(tomorrow) && !prev.tomorrow.includes("|WaitingForSchedule|") ? "змінився" : "опубліковано";
      say(`📅 Графік на завтра (${dm(tomorrow)}) ${verb}: ${dayText(dayOf(row, tomorrow))}`, silent);
    }
  }
  if (!st.sched || prev.today !== sT || prev.tomorrow !== sM) {
    st.sched = { today: sT, tomorrow: sM };
    changed = true;
  }

  // Підготовка: за 30–180 хв до відключення перевіряємо, чи вистачить заряду, і попереджаємо, лише якщо ні
  if (m.online) {
    const t = timeline(row, Date.now());
    const n = nextOff(t);
    if (n != null) {
      const left = minsUntil(t, n);
      let e = n;
      while (e < 96 && t.slots[e] === true) e++;
      const known = e < 96 && t.slots[e] === false;
      const prepKey = `${today}#${n}`;
      if (known && left > WARN_BEFORE_MIN && left <= PREP_BEFORE_MIN && st.prepWarned !== prepKey && m.kwh && m.soc != null) {
        const need = (e - n) * 30 * 60_000;
        const charging = m.batt != null && m.batt < -100 ? -m.batt : 0; // Вт
        const projSoc = Math.min(100, m.soc + (charging / 1000) * (left / 60) / m.kwh * 100);
        const rt = runtimeAt(env, m, projSoc, m.useW);
        if (rt != null && rt < need) {
          st.prepWarned = prepKey;
          changed = true;
          let s = `⚠️ ${slotLabel(n)[0].toUpperCase() + slotLabel(n).slice(1)} відключення за графіком на ${fmtDur(need)} (до ${atLabel(e)}).`;
          s += `\nЗаряду вистачить лише ~на ${fmtDur(rt)} (зараз ${fmt0(m.soc)}%${charging ? `, з урахуванням заряджання до ~${fmt0(projSoc)}%` : ""}).`;
          s += "\nУвімкніть заряд від мережі або плануйте менше навантаження.";
          say(s);
        }
      }
    }
  }

  // Попередження за WARN_BEFORE_MIN хв до відключення за графіком (лише коли світло є)
  if (m.online) {
    const t = timeline(row, Date.now());
    const n = nextOff(t);
    if (n != null) {
      const left = minsUntil(t, n);
      const key = `${today}#${n}`;
      if (left > 0 && left <= WARN_BEFORE_MIN && st.warned !== key) {
        st.warned = key;
        changed = true;
        let s = `⏰ Через ${left} хв відключення за графіком (${slotLabel(n)}).`;
        if (m.soc != null) s += `\n🔋 Заряд: ${fmt0(m.soc)}%`;
        let e = n;
        while (e < 96 && t.slots[e] === true) e++;
        if (e < 96 && t.slots[e] === false) s += batteryVerdict(env, m, (e - n) * 30 * 60_000);
        say(s);
      }
    }
  }
  return changed;
}

// ---------------- здоров'я батареї та контроль бота ----------------

// Оцінка реальної ємності: скільки кВт·год батарея віддала за відключення / на скільки % упав заряд.
// Рахуємо лише відключення з падінням ≥10%, бо SOC — ціле число.
function capacityLearn(st, m) {
  if (st.socStart == null || m.soc == null || !st.outE) return "";
  const drop = st.socStart - m.soc;
  if (drop < 10) return "";
  const kwh = st.outE / 3.6e9; // Вт·мс → кВт·год
  st.capE = (st.capE || 0) + kwh;
  st.capP = (st.capP || 0) + drop;
  st.capN = (st.capN || 0) + 1;
  const est = st.capE / (st.capP / 100);
  return `\n🔬 Оцінка реальної ємності: ${est.toFixed(1)} кВт·год${m.kwh ? ` (${Math.round((est / m.kwh) * 100)}% від паспортної)` : ""}`;
}

function batteryText(env, st, m) {
  const lines = ["🔋 Батарея"];
  if (m.soc != null) lines.push(`Заряд: ${fmt0(m.soc)}%${reserveText(env, m)}`);
  if (m.kwh) lines.push(`Паспортна ємність: ${m.kwh.toFixed(2)} кВт·год`);
  if (st.capP > 0) {
    const est = st.capE / (st.capP / 100);
    lines.push(`Реальна ємність (оцінка): ${est.toFixed(1)} кВт·год${m.kwh ? ` — ${Math.round((est / m.kwh) * 100)}% від паспортної` : ""}`);
    lines.push(`   за ${st.capN} відключенн${st.capN === 1 ? "ям" : "ями"}, сумарно −${fmt0(st.capP)}% заряду`);
  } else {
    lines.push("Реальна ємність: ще рахую — потрібне відключення, за яке заряд упаде хоча б на 10%.");
  }
  if (st.histT > 0) lines.push(`Розряд без світла зазвичай: ${kw(st.histE / st.histT)}`);
  if (m.temp != null) lines.push(`Температура: ${m.temp.toFixed(1)} °C`);
  return lines.join("\n");
}

// Пінг healthchecks.io (або сумісного сервісу): якщо бот перестане працювати, сервіс напише вам сам.
async function healthPing(env, suffix) {
  if (!env.HEALTHCHECK_URL) return;
  try {
    await fetch(env.HEALTHCHECK_URL.replace(/\/+$/, "") + suffix, { method: "GET" });
  } catch (e) {
    console.error("healthcheck:", e.message);
  }
}

// «до 23:40», «завтра о 20:50», «післязавтра о 15:00», «13.11 о 09:10»
function fmtEta(ms) {
  const a = kyiv();
  const b = kyiv(ms);
  const t = fmtTime(ms);
  if (a.date === b.date) return t;
  const days = Math.round((Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${a.date}T00:00:00Z`)) / 86_400_000);
  if (days === 1) return `завтра ${t}`;
  if (days === 2) return `післязавтра ${t}`;
  return `${b.date.split("-").reverse().slice(0, 2).join(".")} ${t}`;
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
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((x) => x.type === t).value;
  const hour = Number(g("hour")) % 24;
  const minute = Number(g("minute"));
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour, minute, mins: hour * 60 + minute };
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
