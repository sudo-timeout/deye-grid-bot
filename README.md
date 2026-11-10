# deye-grid-bot ⚡

Telegram-бот, який повідомляє, **коли зникає і повертається світло**, якщо у вас гібридний інвертор Deye
(або його OEM-версія), підключений до **Deye Cloud**.

Навіщо: штатний застосунок Deye Cloud показує відключення мережі лише у своєму «Центрі повідомлень» —
push-сповіщень про це немає, і в OpenAPI таких подій теж немає. Бот визначає відключення сам,
за напругою та частотою мережі на вході інвертора.

> 🔴 Світло зникло о 21:11. Працюємо від акумулятора.
> 🔋 Заряд: 90%
> ⚡ Навантаження: 0.54 кВт
> ⏳ Вистачить приблизно на 13 год 16 хв (до 20%)

> 🟢 Світло повернулося о 23:21 (228 В).
> Світла не було 2 год 10 хв.
> 🔋 Заряд: 90% → 66% (мінімум 64%)
> ⚡ Використано з батареї ≈ 2.5 кВт·год

## Можливості

- 🔴 / 🟢 зникнення та повернення світла, тривалість, витрата батареї;
- 📊 підсумок дня (о 22:00): споживання, куплено з мережі, заряд/розряд батареї, кількість і тривалість відключень;
- ⚠️ попередження: низький заряд, низька/висока напруга в мережі, холодна батарея (LiFePO4 погано заряджається на морозі), 🔋 100% — без звуку;
- 📶 «немає даних від інвертора понад 10 хв» — якщо вдома зник інтернет;
- команди `/status` (поточний стан) і `/today` (підсумок дня);
- кілька отримувачів: родина або Telegram-група.

## Як це працює

```
Інвертор → логер Wi-Fi → Deye Cloud ← Cloudflare Worker (cron, раз на 2 хв) → Telegram
```

- Працює в **хмарі Cloudflare** (безкоштовний план), тому не залежить від світла й інтернету вдома.
- Кожен розгортає **власну копію у своєму акаунті**: паролі Deye і токен бота зберігаються лише як секрети
  вашого Cloudflare й нікуди більше не передаються.
- Повідомлення надсилаються тільки при змінах стану, у звичайний день бот мовчить.
- Відключення = напруга мережі < 100 В або частота < 40 Гц (під час відключення інвертор показує ~2 В і 0 Гц).

## Встановлення (~15 хв)

**Потрібно:** інвертор у застосунку Deye Cloud; безкоштовний акаунт [Cloudflare](https://dash.cloudflare.com/sign-up);
Node.js 22.12+; роутер і обладнання провайдера живляться від інвертора (інакше під час відключення дані не дійдуть).

1. **Ключі Deye.** Увійдіть на [developer.deyecloud.com](https://developer.deyecloud.com) тим самим акаунтом,
   що й у застосунку → **Application** → скопіюйте `App ID` і `App Secret`
   (кнопка копіювання; **не** натискайте «Update Secret»).
2. **Telegram-бот.** [@BotFather](https://t.me/BotFather) → `/newbot` → токен. Відкрийте свого бота й натисніть **Start**.
   Свій chat id дізнайтеся в [@userinfobot](https://t.me/userinfobot).
3. **Розгортання:**
   ```bash
   git clone https://github.com/AlexeyPilyaev/deye-grid-bot && cd deye-grid-bot
   bash setup.sh
   ```
   Скрипт відкриє браузер для входу в Cloudflare, створить сховище, запитає ключі,
   розгорне бота, підключить команди і надішле тестове повідомлення.
   Під час першого деплою wrangler попросить вигадати піддомен `*.workers.dev` — будь-яке вільне ім'я.

Готово: протягом 2 хвилин прийде «🟢 Моніторинг запущено». Напишіть боту `/status`.

<details>
<summary>Вручну, без setup.sh</summary>

```bash
npx wrangler login
npx wrangler kv namespace create STATE        # id → wrangler.toml
npx wrangler deploy
for s in DEYE_APP_ID DEYE_APP_SECRET DEYE_EMAIL DEYE_PASSWORD TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_IDS ADMIN_KEY; do
  npx wrangler secret put $s
done
curl "https://deye-grid-bot.<піддомен>.workers.dev/setup?key=<ADMIN_KEY>"   # команди /status, /today
```
`ADMIN_KEY` — будь-який довгий випадковий рядок, напр. `openssl rand -hex 16`.
</details>

## Налаштування

У `wrangler.toml`, розділ `[vars]`, після змін — `npx wrangler deploy`:

| Змінна | За замовчуванням | Що робить |
|---|---|---|
| `DEYE_DEVICE_SN` | порожньо | серійник інвертора; порожньо = перший інвертор в акаунті |
| `BATTERY_KWH` | `0` | ємність батареї, кВт·год; `0` = з інвертора (А·год × 51.2 В) |
| `SOC_LOW` | `30` | поріг попередження про низький заряд, % |
| `MIN_SOC` | `20` | до якого % рахувати «на скільки вистачить» |
| `SUMMARY_HOUR` | `22` | година підсумку дня (Київ); `-1` = вимкнути |
| `DEYE_BASE_URL` | EMEA | змініть, якщо акаунт Deye не в європейському дата-центрі |

Секрети: `DEYE_APP_ID`, `DEYE_APP_SECRET`, `DEYE_EMAIL`, `DEYE_PASSWORD`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_IDS` (через кому), `ADMIN_KEY`. Змінити: `npx wrangler secret put ІМ'Я`.

## Службові адреси

Усі — з `?key=<ADMIN_KEY>` (лежить у файлі `.admin_key` після setup.sh):
`/status` — прогнати перевірку зараз, `/debug` — сирі дані інвертора, `/test` — тестове повідомлення,
`/setup` — підключити команди Telegram. Логи: `npx wrangler tail`.

## Обмеження

- **Затримка 1–4 хв:** логер вивантажує дані в хмару раз на ~2 хв. Пришвидшити можна лише через підтримку Deye.
- Короткі «моргання» мережі, коротші за інтервал вивантаження, можуть бути не помічені.
- Ліміти Deye OpenAPI (~60 запитів/хв, ~100 тис./міс на застосунок) — бот використовує ~22 тис./міс.
- Розроблено й перевірено на однофазному Deye LV Hybrid 6 кВт. Якщо у вашої моделі інші назви полів (див. `/debug`),
  поправте регулярні вирази у функції `metrics()` в `src/index.js`.

## Розробка

```bash
npm test              # тести без мережі: фейкові Deye, KV і Telegram
npx wrangler dev      # локальний запуск (секрети — у .dev.vars, див. .dev.vars.example)
```

## Подяки

Формат запитів Deye OpenAPI і ідея визначати відключення за напругою/частотою —
з проєкту [alex-user-accs/grid-outage-worker](https://github.com/alex-user-accs/grid-outage-worker).

Проєкт не пов'язаний із Deye. Ліцензія — [MIT](LICENSE).

---

**English:** a Cloudflare Worker that polls the Deye Cloud OpenAPI every 2 minutes and sends Telegram alerts
when grid power goes out or comes back (Deye Cloud itself has no push notifications for this),
plus a daily summary, voltage/temperature/battery warnings and `/status`, `/today` commands.
Each user deploys their own copy with `bash setup.sh`; credentials stay in their own Cloudflare account.
