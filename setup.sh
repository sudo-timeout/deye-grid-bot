#!/usr/bin/env bash
# Встановлення бота однією командою: Cloudflare-логін, KV, секрети, деплой, перевірка.
# Можна запускати повторно — для оновлення коду або зміни секретів.
set -euo pipefail
cd "$(dirname "$0")"
W="npx --yes wrangler@4"

say() { printf '\n== %s\n' "$*"; }
edit_toml() { # edit_toml <regex> <replacement> — без sed, однаково на macOS і Linux
  RE="$1" REP="$2" node -e 'const f="wrangler.toml",fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(new RegExp(process.env.RE,"m"),process.env.REP))'
}

# --- Node.js ---
if ! command -v node >/dev/null; then
  echo "Потрібен Node.js 22.12+ (https://nodejs.org). Без прав адміністратора:"
  echo '  A=$(uname -m | sed s/x86_64/x64/); F=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -oE "node-v[0-9.]+-darwin-$A\.tar\.gz" | head -1)'
  echo '  curl -fsSL https://nodejs.org/dist/latest-v22.x/$F | tar xz -C ~ && export PATH="$HOME/${F%.tar.gz}/bin:$PATH"'
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || { echo "Потрібен Node.js 22.12+, зараз $(node -v)"; exit 1; }
say "Node $(node -v)"

# --- Cloudflare ---
say "Вхід у Cloudflare"
$W whoami 2>/dev/null | grep -qi "associated with" || $W login

if ! grep -q '^id *= *"' wrangler.toml; then
  say "Створюю KV-сховище STATE"
  OUT=$($W kv namespace create STATE 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$ID" ] || { echo "$OUT"; echo "Не знайшов id KV — додайте його у wrangler.toml вручну"; exit 1; }
  edit_toml '^binding = "STATE"$' "binding = \"STATE\"
id = \"$ID\""
  echo "   KV id: $ID"
fi

# --- налаштування ---
read -rp "Ємність батареї, кВт·год (Enter = взяти з інвертора): " KWH
[ -n "$KWH" ] && edit_toml '^BATTERY_KWH = "[^"]*"' "BATTERY_KWH = \"$KWH\""

# --- секрети ---
ASK_SECRETS=y
if [ -f .admin_key ]; then
  read -rp "Секрети вже задані. Ввести заново? (y/N): " ASK_SECRETS
fi
NAMES="DEYE_APP_ID DEYE_APP_SECRET DEYE_EMAIL DEYE_PASSWORD TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_IDS"
if [[ "$ASK_SECRETS" =~ ^[Yy] ]]; then
  say "Секрети (введення приховане; зберігаються лише у вашому Cloudflare)"
  cat <<'EOF'
  DEYE_APP_ID / DEYE_APP_SECRET — developer.deyecloud.com → Application
  DEYE_EMAIL / DEYE_PASSWORD    — вхід у застосунок Deye Cloud
  TELEGRAM_BOT_TOKEN            — @BotFather → /newbot
  TELEGRAM_CHAT_IDS             — ваш id (@userinfobot); кілька — через кому
EOF
  for s in $NAMES; do
    read -rsp "$s: " v; echo
    [ -n "$v" ] || { echo "Порожнє значення для $s — зупиняюсь"; exit 1; }
    printf -v "SECRET_$s" '%s' "$v"
  done
fi

# --- деплой (інтерактивно: при першому запуску wrangler попросить обрати піддомен workers.dev) ---
say "Деплой"
$W deploy

if [[ "$ASK_SECRETS" =~ ^[Yy] ]]; then
  say "Записую секрети"
  for s in $NAMES; do
    v="SECRET_$s"; printf '%s' "${!v}" | $W secret put "$s" >/dev/null && echo "   $s ✓"
  done
  ADMIN_KEY=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
  printf '%s' "$ADMIN_KEY" | $W secret put ADMIN_KEY >/dev/null && echo "   ADMIN_KEY ✓"
  echo "$ADMIN_KEY" > .admin_key && chmod 600 .admin_key
fi
ADMIN_KEY=$(cat .admin_key)

# --- перевірка ---
echo
read -rp "Вставте адресу воркера з виводу вище (https://deye-grid-bot.<...>.workers.dev): " URL
URL="${URL%/}"
say "Чекаю, поки адреса стане доступною (новий піддомен — до кількох хвилин)"
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || true)" = "403" ] && break  # 403 = воркер відповідає
  sleep 15
done
say "Підключаю команди Telegram (/status, /today)"
curl -s "$URL/setup?key=$ADMIN_KEY" || true; echo
say "Тестове повідомлення"
curl -s "$URL/test?key=$ADMIN_KEY" || true; echo
say "Дані інвертора"
curl -s "$URL/debug?key=$ADMIN_KEY" | head -c 1500 || true; echo
echo
echo "Готово. Напишіть боту /status. Логи: npx wrangler tail"
