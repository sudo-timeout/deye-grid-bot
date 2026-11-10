// Тести графіків відключень (Alerts Energy) без мережі.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const kyiv = (ms = Date.now()) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, mins: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
};
const nowSlot = () => Math.floor(kyiv().mins / 30);
const today = () => kyiv().date;
const tomorrow = () => kyiv(Date.parse(`${today()}T12:00:00Z`) + 86_400_000).date;

// 96 півгодинних слотів (сьогодні+завтра) → два масиви по 24 години у форматі API
function toHours(slots48) {
  const h = [];
  for (let i = 0; i < 48; i += 2) {
    const a = slots48[i], b = slots48[i + 1];
    h.push(a && b ? 1 : a ? 2 : b ? 3 : 0);
  }
  return h;
}
function rowFrom(off, { todayStatus = "ScheduleApplies", tomorrowStatus = "ScheduleApplies" } = {}) {
  const s = Array(96).fill(false);
  for (const i of off) if (i >= 0 && i < 96) s[i] = true;
  return {
    initiator: "test-oblenergo", queue: "3.2",
    today: toHours(s.slice(0, 48)), tomorrow: tomorrowStatus === "WaitingForSchedule" ? [] : toHours(s.slice(48)),
    today_date: today(), tomorrow_date: tomorrow(), today_status: todayStatus, tomorrow_status: tomorrowStatus,
  };
}

let kv, sent, reading, rows, aeCalls, env;
beforeEach(() => {
  kv = new Map(); sent = []; aeCalls = 0;
  reading = { V: 230, F: 50, soc: 90 };
  rows = [rowFrom([]), { ...rowFrom([1, 2, 3]), initiator: "uz" }];
  env = {
    DEYE_DEVICE_SN: "SN1", DEYE_APP_ID: "id", DEYE_APP_SECRET: "s", DEYE_EMAIL: "e", DEYE_PASSWORD: "p",
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_IDS: "42", ADMIN_KEY: "k", BATTERY_KWH: "15", SUMMARY_HOUR: "-1",
    ALERTS_ENERGY_KEY: "ae", SCHEDULE_AREA: "test-oblast", SCHEDULE_SUPPLIER: "test-oblenergo", SCHEDULE_QUEUE: "3.2",
    STATE: {
      get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => kv.set(k, v),
      delete: async (k) => kv.delete(k),
    },
  };
  globalThis.fetch = async (url, o) => {
    if (url.includes("alerts.energy")) {
      aeCalls++;
      assert.equal(o.headers.Authorization, "Bearer ae");
      return Response.json(rows);
    }
    const b = o.body ? JSON.parse(o.body) : {};
    if (url.includes("api.telegram.org")) {
      if (url.endsWith("/sendMessage")) sent.push(b.text);
      return Response.json({ ok: true });
    }
    if (url.includes("/account/token")) return Response.json({ code: "1000000", accessToken: "tok", expiresIn: 5184000 });
    const kvs = { GridVoltageL1L2: reading.V, GridFrequency: reading.F, SOC: reading.soc, TotalConsumptionPower: reading.load ?? 500, BatteryPower: reading.batt ?? 500 };
    if (reading.dayCons != null) kvs.DailyConsumption = reading.dayCons;
    return Response.json({ code: "1000000", deviceDataList: [{ deviceSn: "SN1", collectionTime: Math.floor(Date.now() / 1000) - 30,
      dataList: Object.entries(kvs).map(([key, value]) => ({ key, value: String(value) })) }] });
  };
});

const tick = () => worker.fetch(new Request("https://w.dev/status?key=k"), env, { waitUntil() {} });
const gridDown = () => Object.assign(reading, { V: 2, F: 0 });
const resetCache = () => kv.delete("sched");

test("відключення за графіком: коли дадуть світло і чи вистачить батареї", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n, n + 1, n + 2, n + 3]); // ще ~1.5–2 год без світла
  await tick();
  gridDown(); resetCache();
  await tick();
  const msg = sent.at(-1);
  assert.match(msg, /Світло зникло/);
  assert.match(msg, /За графіком світло має з'явитися/);
  assert.match(msg, /✅ Батареї має вистачити/); // 15 кВт·год × 70% / 0.5 кВт ≫ 2 год
});

test("відключення поза графіком → схоже на аварійне", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n + 6, n + 7]);
  await tick();
  gridDown(); resetCache();
  await tick();
  assert.match(sent.at(-1), /схоже на аварійне/);
});

test("аварійні відключення: графік не діє", async () => {
  rows[0] = rowFrom([], { todayStatus: "EmergencyShutdowns" });
  await tick();
  gridDown(); resetCache();
  await tick();
  assert.match(sent.at(-1), /аварійні відключення — графік зараз не діє/);
});

test("не вистачить батареї при довгому відключенні", async () => {
  const n = nowSlot();
  rows[0] = rowFrom(Array.from({ length: 18 }, (_, i) => n + i)); // ~9 год, а заряду на ~7
  env.BATTERY_KWH = "5";
  await tick();
  gridDown(); resetCache();
  await tick();
  assert.match(sent.at(-1), /❌ Батареї може не вистачити/);
});

test("графік на завтра: опубліковано і змінився — по одному повідомленню", async () => {
  rows[0] = rowFrom([], { tomorrowStatus: "WaitingForSchedule" });
  await tick(); // перший запуск — запам'ятовуємо мовчки
  rows[0] = rowFrom([48 + 4, 48 + 5]); resetCache();
  await tick();
  await tick();
  assert.equal(sent.filter((t) => /Графік на завтра .* опубліковано: 02:00–03:00/.test(t)).length, 1);
  rows[0] = rowFrom([48 + 4, 48 + 5, 48 + 6]); resetCache();
  await tick();
  assert.match(sent.at(-1), /Графік на завтра .* змінився: 02:00–03:30/);
});

test("попередження за 30 хв до відключення за графіком", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n + 1, n + 2]);
  await tick();
  await tick();
  assert.equal(sent.filter((t) => /⏰ Через \d+ хв відключення за графіком/.test(t)).length, 1);
});

test("графік далі невідомий → «щонайменше до»", async () => {
  const n = nowSlot();
  rows[0] = rowFrom(Array.from({ length: 96 }, (_, i) => i).filter((i) => i >= n));
  await tick();
  gridDown(); resetCache();
  await tick();
  assert.match(sent.at(-1), /без світла щонайменше до 24:00 завтра/);
});

test("графік кешується, а не запитується щоразу", async () => {
  await tick(); await tick(); await tick();
  assert.equal(aeCalls, 1);
});

test("без ключа Alerts Energy усе працює як раніше", async () => {
  delete env.ALERTS_ENERGY_KEY;
  await tick();
  gridDown();
  await tick();
  assert.equal(aeCalls, 0);
  assert.match(sent.at(-1), /Світло зникло/);
  assert.doesNotMatch(sent.at(-1), /графік/i);
});

test("/schedule у Telegram і службовий /schedule", async () => {
  rows[0] = rowFrom([0, 1, 20, 21, 22]);
  const pending = [];
  await worker.fetch(new Request("https://w.dev/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "k" },
    body: JSON.stringify({ message: { chat: { id: 42 }, text: "/schedule" } }) }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.match(sent.at(-1), /Сьогодні .*: 00:00–01:00, 10:00–11:30 \(2,5 год\)/);
  const dbg = await (await worker.fetch(new Request("https://w.dev/schedule?key=k"), env, {})).json();
  assert.equal(dbg.found, true);
  assert.deepEqual(dbg.operators.sort(), ["test-oblenergo", "uz"]);
});

test("/status, коли за графіком відключення, а світло є", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n, n + 1, n + 2]);
  const pending = [];
  await worker.fetch(new Request("https://w.dev/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "k" },
    body: JSON.stringify({ message: { chat: { id: 42 }, text: "/status" } }) }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.match(sent.at(-1), /За графіком зараз відключення \((щонайменше )?до \d\d:\d\d( завтра)?\), але світло є/);
});

test("/preview показує прогноз і нічого не змінює", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n + 2, n + 3, n + 4]);
  const pending = [];
  await worker.fetch(new Request("https://w.dev/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "k" },
    body: JSON.stringify({ message: { chat: { id: 42 }, text: "/preview" } }) }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const msg = sent.at(-1);
  assert.match(msg, /Перевірка прогнозу/);
  assert.match(msg, /схоже на аварійне/); // зараз за графіком світло є
  assert.match(msg, /Наступне відключення за графіком .* — до .* \(1 год 30 хв\)/);
  assert.match(msg, /✅ Батареї має вистачити/);
  assert.equal(kv.has("state"), false);
});


const tgCmd = async (text) => {
  const pending = [];
  await worker.fetch(new Request("https://w.dev/tg", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "k" },
    body: JSON.stringify({ message: { chat: { id: 42 }, text } }) }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return sent.at(-1);
};

test("прогноз під час відключення — за фактичним розрядом, а не за миттєвим піком", async () => {
  delete env.ALERTS_ENERGY_KEY;
  const now = Date.now();
  kv.set("state", JSON.stringify({ grid: "down", since: now - 3_600_000, socStart: 90, outE: 400 * 3_600_000, outT: 3_600_000, outLast: now - 60_000 }));
  Object.assign(reading, { V: 2, F: 0, soc: 80, load: 1500, batt: 1600 });
  const msg = await tgCmd("/status");
  // 15 кВт·год × (80−20)% = 9 кВт·год / 0.4 кВт ≈ 22.5 год; при піку 1.5 кВт (×1.1) — ~5.5 год
  assert.match(msg, /⏳ Вистачить до .+ \(~22 год 30 хв\), як зазвичай без світла \(0\.40 кВт\)/);
  assert.match(msg, /якщо споживати як зараз \(1\.50 кВт\) — до .+ \(~5 год 27 хв\)/);
  assert.match(msg, /🔋 80% · ≈9\.0 кВт·год у запасі/);
});

test("бот запам'ятовує розряд під час відключень і рахує за ним, коли світло є", async () => {
  delete env.ALERTS_ENERGY_KEY;
  const now = Date.now();
  kv.set("state", JSON.stringify({ grid: "down", since: now - 7_200_000, socStart: 90, socMin: 80, outE: 350 * 7_200_000, outT: 7_200_000, outLast: now - 60_000 }));
  Object.assign(reading, { V: 228, F: 50, soc: 80, load: 900, batt: -2000 });
  await tick(); // світло повернулося
  assert.match(sent.at(-1), /📉 Середній розряд за відключення: 0\.35 кВт/);
  assert.match(sent.at(-1), /🔬 Оцінка реальної ємності: 7\.0 кВт·год \(47% від паспортної\)/); // 0.7 кВт·год за −10%
  const msg = await tgCmd("/status");
  assert.match(msg, /⏳ Якщо світло зникне — вистачить до .+, як зазвичай без світла \(0\.35 кВт\)/);
  assert.match(msg, /якщо споживати як зараз \(0\.90 кВт\)/);
  const bat = await tgCmd("/battery");
  assert.match(bat, /Реальна ємність \(оцінка\): 7\.0 кВт·год — 47% від паспортної/);
  assert.match(bat, /Розряд без світла зазвичай: 0\.35 кВт/);
});

test("без історії відключень — за поточним навантаженням, із поясненням у /preview", async () => {
  rows[0] = rowFrom([]);
  const msg = await tgCmd("/preview");
  assert.match(msg, /Зараз 90% \(≈10\.5 кВт·год до 20%\)/);
  assert.match(msg, /Якщо світло зникне — вистачить до .+, якщо споживати як зараз \(0\.50 кВт\)/);
  assert.match(msg, /Після першого відключення бот запам'ятає/);
});

test("підготовка: попередження, якщо заряду не вистачить на наступне відключення", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n + 3, n + 4, n + 5, n + 6]); // через 60–90 хв, на 2 год
  env.BATTERY_KWH = "2"; // (50−20)% × 2 кВт·год = 0.6 кВт·год / 0.55 кВт ≈ 1 год 5 хв < 2 год
  reading.soc = 50;
  await tick();
  await tick();
  const warns = sent.filter((t) => /відключення за графіком на 2 год 0 хв/.test(t));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Заряду вистачить лише ~на 1 год/);
  assert.match(warns[0], /Увімкніть заряд від мережі/);
});

test("підготовка: якщо заряду вистачає — мовчить", async () => {
  const n = nowSlot();
  rows[0] = rowFrom([n + 3, n + 4]);
  await tick();
  await tick();
  assert.equal(sent.filter((t) => /Заряду вистачить лише/.test(t)).length, 0);
});

test("аварійні відключення: оголошення і скасування", async () => {
  rows[0] = rowFrom([]);
  await tick();
  rows[0] = rowFrom([], { todayStatus: "EmergencyShutdowns" }); resetCache();
  await tick();
  assert.match(sent.at(-1), /🚨 Оператор оголосив аварійні відключення/);
  rows[0] = rowFrom([2, 3]); resetCache();
  await tick();
  assert.match(sent.at(-1), /✅ Аварійні відключення скасовано. Графік на сьогодні: 01:00–02:00/);
});

test("підсумок дня: за графіком vs фактично", async () => {
  rows[0] = rowFrom([0, 1, 2, 3, 4, 5]); // 3 год за графіком
  env.SUMMARY_HOUR = String(Math.floor(kyiv().mins / 60));
  await tick();
  assert.ok(sent.some((t) => /За графіком без світла 3 год 0 хв, фактично 0 хв/.test(t)));
});


test("healthcheck: пінг після кожної перевірки, /fail при помилці Deye", async () => {
  env.HEALTHCHECK_URL = "https://hc-ping.com/abc/";
  const pings = [];
  const orig = globalThis.fetch;
  let deyeDown = false;
  globalThis.fetch = async (url, o) => {
    if (url.startsWith("https://hc-ping.com")) { pings.push(url); return new Response("OK"); }
    if (deyeDown && url.includes("deyecloud")) return new Response("boom", { status: 500 });
    return orig(url, o);
  };
  await tick();
  deyeDown = true;
  await tick();
  assert.deepEqual(pings, ["https://hc-ping.com/abc", "https://hc-ping.com/abc/fail"]);
});

test("/battery без історії — пояснює, що ще рахує", async () => {
  const msg = await tgCmd("/battery");
  assert.match(msg, /Паспортна ємність: 15\.00 кВт·год/);
  assert.match(msg, /ще рахую/);
});
