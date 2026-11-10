// Тести без мережі: фейкові Deye API, KV і Telegram. Запуск: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

let kv, sent, reading, ageSec, env, pending;

const kyivHour = () =>
  Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }).format(new Date())) % 24;

beforeEach(() => {
  kv = new Map();
  sent = [];
  pending = [];
  ageSec = 60;
  reading = { V: 230, F: 50, soc: 90, load: 540, batt: 0, temp: 22 };
  env = {
    DEYE_DEVICE_SN: "SN1",
    DEYE_APP_ID: "id",
    DEYE_APP_SECRET: "secret",
    DEYE_EMAIL: "e@x",
    DEYE_PASSWORD: "p",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_IDS: "42",
    ADMIN_KEY: "k",
    BATTERY_KWH: "0",
    SUMMARY_HOUR: "-1", // підсумок вимкнено, доки тест сам не попросить
    STATE: {
      get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => kv.set(k, v),
      delete: async (k) => kv.delete(k),
    },
  };
  globalThis.fetch = async (url, o) => {
    const b = JSON.parse(o.body);
    if (url.includes("api.telegram.org")) {
      if (url.endsWith("/sendMessage")) sent.push({ chat: String(b.chat_id), text: b.text, silent: !!b.disable_notification });
      return Response.json({ ok: true });
    }
    if (url.includes("/account/token")) return Response.json({ code: "1000000", accessToken: "tok", expiresIn: 5184000 });
    const r = reading;
    const kvs = {
      GridVoltageL1L2: r.V, GridFrequency: r.F, TotalConsumptionPower: r.load, BatteryPower: r.batt, SOC: r.soc,
      BatteryRatedCapacity: 200, BMSTemperature: r.temp, DailyConsumption: 19.6, DailyEnergyPurchased: 18.8,
      DailyChargingEnergy: 4.5, DailyDischargingEnergy: 5.3,
    };
    return Response.json({
      code: "1000000",
      deviceDataList: [{
        deviceSn: "SN1",
        collectionTime: Math.floor(Date.now() / 1000) - ageSec,
        dataList: Object.entries(kvs).map(([key, value]) => ({ key, value: String(value) })),
      }],
    });
  };
});

const ctx = { waitUntil: (p) => pending.push(p) };
const tick = () => worker.fetch(new Request("https://w.dev/status?key=k"), env, ctx);
const texts = () => sent.map((s) => s.text);
const tgMessage = async (chat, text, secret = "k") => {
  const res = await worker.fetch(
    new Request("https://w.dev/tg", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ message: { chat: { id: Number(chat) }, text } }),
    }),
    env,
    ctx,
  );
  await Promise.all(pending);
  return res.status;
};

test("перший запуск повідомляє стан один раз", async () => {
  await tick();
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Моніторинг запущено\. Світло є/);
});

test("зникнення і повернення світла зі статистикою", async () => {
  await tick();
  Object.assign(reading, { V: 1.8, F: 0, batt: 600 });
  await tick();
  assert.match(texts().at(-1), /Світло зникло/);
  assert.match(texts().at(-1), /⏳ Вистачить до .+ \(~\d+ год \d+ хв\)/);
  reading.soc = 64;
  await tick();
  Object.assign(reading, { V: 228, F: 50, soc: 66, batt: -1900 });
  await tick();
  const back = texts().at(-1);
  assert.match(back, /Світло повернулося/);
  assert.match(back, /90% → 66% \(мінімум 64%\)/);
  assert.match(back, /≈ 2\.5 кВт·год/); // (90-66)% × 200 А·год × 51.2 В
});

test("попередження надсилаються один раз, 100% — без звуку", async () => {
  await tick();
  Object.assign(reading, { V: 185, temp: 3, soc: 100 });
  await tick();
  await tick();
  assert.equal(texts().filter((t) => /Низька напруга/.test(t)).length, 1);
  assert.equal(texts().filter((t) => /холодна/.test(t)).length, 1);
  assert.equal(sent.find((s) => /100%/.test(s.text)).silent, true);
});

test("немає свіжих даних → попередження і відновлення", async () => {
  await tick();
  ageSec = 15 * 60;
  await tick();
  assert.match(texts().at(-1), /не надсилає даних/);
  ageSec = 60;
  await tick();
  assert.match(texts().at(-1), /знову надходять/);
});

test("підсумок дня — один раз на добу", async () => {
  env.SUMMARY_HOUR = String(kyivHour());
  await tick();
  await tick();
  assert.equal(texts().filter((t) => /Підсумок дня/.test(t)).length, 1);
});

test("команди Telegram: /status, захист вебхука, чужі чати", async () => {
  assert.equal(await tgMessage("42", "/status", "wrong"), 403);
  await tgMessage("42", "/status");
  assert.match(texts().at(-1), /🔋 90%/);
  await tgMessage("7", "/status");
  assert.equal(sent.at(-1).chat, "7");
  assert.match(texts().at(-1), /приватний бот/);
});

test("службові ендпоінти без ключа закриті", async () => {
  const res = await worker.fetch(new Request("https://w.dev/debug"), env, ctx);
  assert.equal(res.status, 403);
});
