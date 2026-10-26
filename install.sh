#!/usr/bin/env bash
# Установка Speedtest одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/tovich/speedtest/main/install.sh | sudo bash
#
# С параметрами:
#   curl -fsSL https://raw.githubusercontent.com/tovich/speedtest/main/install.sh | sudo bash -s -- --domain speed.example.com
#
# Повторный запуск обновляет сервис до свежей версии и сохраняет настройки.
set -euo pipefail

IMAGE="ghcr.io/tovich/speedtest:latest"
DIR="${SPEEDTEST_DIR:-/opt/speedtest}"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_b=$'\e[1m'; c_0=$'\e[0m'
[[ -t 1 ]] || { c_ok=; c_warn=; c_err=; c_b=; c_0=; }
log()  { echo "${c_ok}▸${c_0} $*"; }
warn() { echo "${c_warn}!${c_0} $*" >&2; }
die()  { echo "${c_err}✗ $*${c_0}" >&2; exit 1; }

usage() {
  cat <<'EOF'
Установка Speedtest (сервер измерения скорости интернета).

Параметры:
  --domain ДОМЕН         HTTPS с сертификатом Let's Encrypt (встроенный Caddy, нужны свободные 80 и 443)
  --proxy-network СЕТЬ   подключить к docker-сети своего прокси (например, Nginx Proxy Manager);
                         HTTP-порт наружу не публикуется, в прокси указать speedtest:8080
  --behind-proxy         сервис стоит за прокси: IP клиента брать из X-Forwarded-For
  --direct               сбросить режимы домена/прокси: прямой доступ по HTTP-порту
  --port ПОРТ            HTTP-порт (по умолчанию 8080)
  --udp-port ПОРТ        UDP-порт теста потерь пакетов (по умолчанию 3479)
  --name ИМЯ             название в шапке страницы
  --location ГОРОД       расположение сервера, показывается посетителям
  --public-ip IP         внешний IP для UDP-теста, если сервер за NAT
  --no-city              GeoIP только по странам (базы ~20 МБ вместо ~135 МБ)
  --uninstall            удалить сервис и его данные
  -h, --help             эта справка

Каталог установки: /opt/speedtest (переменная SPEEDTEST_DIR).
EOF
}

# Всё тело — в функции: при запуске через «curl | bash» bash сначала прочитает скрипт целиком,
# и дочерние команды (apt, docker) не смогут случайно прочитать его остаток из stdin.
main() {

# ---- настройки: сначала прошлые из .env, поверх — параметры командной строки ----
HTTP_PORT=8080 RTC_UDP_PORT=3479 SERVER_NAME=Speedtest SERVER_LOCATION="" RTC_PUBLIC_IP=""
TRUST_PROXY=false GEOIP_CITY=true DOMAIN="" PROXY_NETWORK=""

if [[ -f "$DIR/.env" ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_]+$ ]] || continue
    v="${v%\"}"; v="${v#\"}"
    case "$k" in
      HTTP_PORT|RTC_UDP_PORT|SERVER_NAME|SERVER_LOCATION|RTC_PUBLIC_IP|TRUST_PROXY|GEOIP_CITY|DOMAIN|PROXY_NETWORK) printf -v "$k" '%s' "$v" ;;
    esac
  done < "$DIR/.env"
fi

ACTION=install
need() { [[ $# -ge 2 && -n "$2" ]] || die "параметру $1 нужно значение"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        need "$@"; DOMAIN="$2"; shift 2 ;;
    --proxy-network) need "$@"; PROXY_NETWORK="$2"; shift 2 ;;
    --behind-proxy)  TRUST_PROXY=true; shift ;;
    --direct)        DOMAIN=""; PROXY_NETWORK=""; TRUST_PROXY=false; shift ;;
    --port)          need "$@"; HTTP_PORT="$2"; shift 2 ;;
    --udp-port)      need "$@"; RTC_UDP_PORT="$2"; shift 2 ;;
    --name)          need "$@"; SERVER_NAME="$2"; shift 2 ;;
    --location)      need "$@"; SERVER_LOCATION="$2"; shift 2 ;;
    --public-ip)     need "$@"; RTC_PUBLIC_IP="$2"; shift 2 ;;
    --no-city)       GEOIP_CITY=false; shift ;;
    --uninstall)     ACTION=uninstall; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "нужны права root: запустите через sudo"
[[ "$HTTP_PORT" =~ ^[0-9]+$ && "$RTC_UDP_PORT" =~ ^[0-9]+$ ]] || die "порт должен быть числом"
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "некорректный домен: $DOMAIN"
[[ -z "$PROXY_NETWORK" || "$PROXY_NETWORK" =~ ^[A-Za-z0-9_.-]+$ ]] || die "некорректное имя сети: $PROXY_NETWORK"
# в .env значения в кавычках — убираем то, что может их сломать
SERVER_NAME="${SERVER_NAME//[\"\$\`\\]/}"
SERVER_LOCATION="${SERVER_LOCATION//[\"\$\`\\]/}"

# ---- удаление ----
if [[ $ACTION == uninstall ]]; then
  [[ -d "$DIR" ]] || die "Speedtest не найден в $DIR"
  log "Останавливаю и удаляю контейнеры и данные…"
  (cd "$DIR" && docker compose down -v --remove-orphans) || true
  rm -rf "$DIR"
  log "Готово: Speedtest удалён."
  exit 0
fi

# ---- проверки системы ----
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "архитектура $(uname -m) не поддерживается (нужна amd64 или arm64)" ;;
esac
command -v curl >/dev/null || die "нужен curl"

# ---- Docker ----
if ! command -v docker >/dev/null; then
  log "Устанавливаю Docker…"
  curl -fsSL https://get.docker.com | sh
fi
command -v systemctl >/dev/null && systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  log "Устанавливаю docker compose…"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq docker-compose-plugin
  elif command -v dnf >/dev/null; then dnf install -y -q docker-compose-plugin
  elif command -v yum >/dev/null; then yum install -y -q docker-compose-plugin
  fi
  docker compose version >/dev/null 2>&1 || die "не удалось установить docker compose"
fi

port_busy() { command -v ss >/dev/null && ss -Hltn "sport = :$1" | grep -q .; }

if [[ -n "$PROXY_NETWORK" ]]; then
  docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1 \
    || die "docker-сеть «$PROXY_NETWORK» не найдена. Список: docker network ls"
  TRUST_PROXY=true
fi
if [[ -n "$DOMAIN" ]]; then
  [[ -z "$PROXY_NETWORK" ]] || die "--domain и --proxy-network вместе не используются"
  TRUST_PROXY=true
  running_here=$(cd "$DIR" 2>/dev/null && docker compose ps -q caddy 2>/dev/null || true)
  if [[ -z "$running_here" ]]; then
    for p in 80 443; do
      port_busy $p && die "порт $p уже занят (другой веб-сервер или прокси?). Используйте --proxy-network или --behind-proxy"
    done
  fi
fi

# Подсказка, если на сервере уже есть Nginx Proxy Manager
if [[ -z "$DOMAIN$PROXY_NETWORK" ]]; then
  npm=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '/nginx-proxy-manager/ {print $1; exit}')
  if [[ -n "$npm" ]]; then
    net=$(docker inspect "$npm" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
    warn "Найден Nginx Proxy Manager ($npm). Чтобы публиковать через него, запустите установку с: --proxy-network $net"
  fi
fi

# ---- файлы ----
mkdir -p "$DIR"
cd "$DIR"

cat > .env <<EOF
HTTP_PORT=$HTTP_PORT
RTC_UDP_PORT=$RTC_UDP_PORT
SERVER_NAME="$SERVER_NAME"
SERVER_LOCATION="$SERVER_LOCATION"
RTC_PUBLIC_IP=$RTC_PUBLIC_IP
TRUST_PROXY=$TRUST_PROXY
GEOIP_CITY=$GEOIP_CITY
DOMAIN=$DOMAIN
PROXY_NETWORK=$PROXY_NETWORK
EOF

{
  cat <<EOF
# Создано install.sh. Настройки — в .env, после правки: docker compose up -d
services:
  speedtest:
    image: $IMAGE
    restart: unless-stopped
    ports:
EOF
  [[ -z "$DOMAIN$PROXY_NETWORK" ]] && echo '      - "${HTTP_PORT}:8080"'
  cat <<'EOF'
      - "${RTC_UDP_PORT}:${RTC_UDP_PORT}/udp"
    environment:
      SERVER_NAME: ${SERVER_NAME}
      SERVER_LOCATION: ${SERVER_LOCATION}
      RTC_UDP_PORT: ${RTC_UDP_PORT}
      RTC_PUBLIC_IP: ${RTC_PUBLIC_IP}
      TRUST_PROXY: ${TRUST_PROXY}
      GEOIP_CITY: ${GEOIP_CITY}
    volumes:
      - geoip:/data
    ulimits:
      nofile: 65536
    healthcheck:
      test: ["CMD", "/speedtest", "healthcheck"]
      interval: 10s
      timeout: 5s
      start_period: 5s
EOF
  [[ -n "$PROXY_NETWORK" ]] && printf '    networks: [default, proxy]\n'
  if [[ -n "$DOMAIN" ]]; then
    cat <<'EOF'

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [speedtest]
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy:/data
EOF
  fi
  printf '\nvolumes:\n  geoip:\n'
  [[ -n "$DOMAIN" ]] && printf '  caddy:\n'
  if [[ -n "$PROXY_NETWORK" ]]; then
    printf '\nnetworks:\n  proxy:\n    external: true\n    name: %s\n' "$PROXY_NETWORK"
  fi
} > docker-compose.yml

if [[ -n "$DOMAIN" ]]; then
  cat > Caddyfile <<'EOF'
{$DOMAIN} {
	encode {
		gzip
		match {
			not path /api/*
		}
	}
	reverse_proxy speedtest:8080 {
		flush_interval -1
		request_buffers 0
		response_buffers 0
	}
}
EOF
else
  rm -f Caddyfile
fi

# ---- файрвол (если включён) ----
open_port() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$1" >/dev/null
  fi
  if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd -q --permanent --add-port="$1" && firewall-cmd -q --reload
  fi
}
open_port "$RTC_UDP_PORT/udp"
if [[ -n "$DOMAIN" ]]; then open_port 80/tcp; open_port 443/tcp; open_port 443/udp
elif [[ -z "$PROXY_NETWORK" ]]; then open_port "$HTTP_PORT/tcp"
fi

# ---- запуск ----
log "Скачиваю образ…"
docker compose pull -q
log "Запускаю…"
docker compose up -d --remove-orphans

cid=$(docker compose ps -q speedtest)
status=""
for _ in $(seq 1 45); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)
  [[ "$status" == healthy ]] && break
  sleep 2
done
[[ "$status" == healthy ]] || { docker compose logs --tail 30 speedtest; die "сервис не запустился"; }

ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')
echo
echo "${c_b}Speedtest запущен.${c_0}"
if [[ -n "$DOMAIN" ]]; then
  echo "  Адрес: https://$DOMAIN  (сертификат выпускается при первом заходе, домен должен указывать на этот сервер)"
elif [[ -n "$PROXY_NETWORK" ]]; then
  echo "  В прокси создайте хост: http://speedtest:8080, включите Websockets Support,"
  echo "  в Advanced добавьте: client_max_body_size 0; proxy_buffering off; proxy_request_buffering off;"
else
  echo "  Адрес: http://${ip:-<IP сервера>}:$HTTP_PORT"
fi
echo "  UDP-тест потерь пакетов: порт $RTC_UDP_PORT/udp должен быть доступен снаружи."
echo "  Каталог: $DIR  ·  обновление — запустить установку ещё раз  ·  удаление — с параметром --uninstall"
echo "  Базы GeoIP скачиваются в фоне в первые минуты после установки."
}

main "$@"
