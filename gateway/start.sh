#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

gateway_ip=${DORIS_STUDIO_GATEWAY_IP:-}
port=4173
app_container=doris-studio
app_image=doris-studio:1.0.0
gateway_container=doris-studio-gateway
gateway_image=doris-studio-gateway:1.0.0
# The upstream binary has a file capability for low ports. The gateway uses
# port 4173, so execute a private copy without that capability under --cap-drop ALL.
caddy_exec_mount='/run/doris-caddy:rw,exec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700'
caddy_bootstrap='umask 077; cat /usr/bin/caddy > /run/doris-caddy/caddy; chmod 0500 /run/doris-caddy/caddy; exec /run/doris-caddy/caddy "$@"'
managed_label=io.doris-studio.gateway.managed
mode_label=io.doris-studio.gateway.mode
state_dir=/var/lib/doris-studio-gateway
config_dir="$state_dir/config"
config_backup="$config_dir/Caddyfile.previous"
url="http://$gateway_ip:$port"
staging=

die() {
  printf '启动失败：%s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n $staging ]]; then
    rm -f -- "$staging/Caddyfile" "$staging/users.caddy"
    rmdir -- "$staging"
  fi
}
trap cleanup EXIT

case "${1:-}" in
  '') rotate=0 ;;
  --rotate-password) rotate=1 ;;
  -h|--help)
    printf '用法：sudo DORIS_STUDIO_GATEWAY_IP=<服务器内网IPv4> bash %q [--rotate-password]\n' "$0"
    exit 0
    ;;
  *) die '仅支持 --rotate-password 或 --help。' ;;
esac
[[ $# -le 1 ]] || die '参数过多。'
[[ $EUID == 0 ]] || die "请使用 sudo bash $0。"
[[ $gateway_ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ && $gateway_ip != 127.* ]] ||
  die '请通过 DORIS_STUDIO_GATEWAY_IP 指定服务器内网 IPv4 地址。'
script_dir=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
template="$script_dir/Caddyfile"
for tool in docker systemctl ip awk cmp curl flock install stat; do
  command -v "$tool" >/dev/null || die "缺少命令 $tool。"
done
[[ -f $template ]] || die "找不到 $template。"
gateway_config=$(<"$template")
gateway_config=${gateway_config//__DORIS_STUDIO_GATEWAY_IP__/$gateway_ip}

if ! ip -4 -o addr show | awk -v target="$gateway_ip" '
  $3 == "inet" { split($4, address, "/"); if (address[1] == target) found = 1 }
  END { exit !found }
'; then
  die "本机网卡没有 $gateway_ip，无法绑定网关。请在该地址所在的服务器运行。"
fi

systemctl start docker
docker info >/dev/null || die '无法访问 Docker Engine。'
docker image inspect "$gateway_image" >/dev/null 2>&1 ||
  die "本地缺少 $gateway_image，请先用 docker load 导入网关镜像。"
app_settings=$(docker container inspect --format '{{.Config.Image}} {{.HostConfig.NetworkMode}}' "$app_container" 2>/dev/null) ||
  die "找不到现有容器 $app_container，请先按部署说明启动它。"
[[ $app_settings == "$app_image host" ]] ||
  die "现有 $app_container 的镜像或网络模式不匹配。需要 $app_image 和 host 网络。"

existing_gateway=0
replace_gateway=0
if gateway_id=$(docker container inspect --format '{{.Id}}' "$gateway_container" 2>/dev/null); then
  [[ $gateway_id =~ ^[a-f0-9]{64}$ ]] || die "无法确认容器 $gateway_container 的 ID。"
  gateway_settings=$(docker container inspect --format \
    '{{index .Config.Labels "io.doris-studio.gateway.managed"}} {{.Config.Image}} {{.HostConfig.NetworkMode}}' \
    "$gateway_id")
  [[ $gateway_settings == "true $gateway_image host" ]] ||
    die "容器名 $gateway_container 已被其他配置使用。"
  existing_gateway=1
  gateway_mode=$(docker container inspect --format '{{index .Config.Labels "io.doris-studio.gateway.mode"}}' "$gateway_id")
  case "$gateway_mode" in
    http-v1) ;;
    ''|'<no value>') replace_gateway=1 ;;
    *) die "现有网关的运行模式 $gateway_mode 不匹配。" ;;
  esac
fi

if [[ -e $state_dir || -L $state_dir ]]; then
  [[ ! -L $state_dir && -d $state_dir && $(stat -c '%u:%g:%a' "$state_dir") == 0:0:700 ]] ||
    die "状态目录 $state_dir 必须是 root:root 的 0700 实体目录。"
  [[ ! -L $state_dir/.managed && -f $state_dir/.managed && $(<"$state_dir/.managed") == doris-studio-gateway-v1 ]] ||
    die "状态目录 $state_dir 缺少管理标记。"
else
  [[ $existing_gateway == 0 ]] || die "现有网关缺少状态目录 $state_dir。"
  install -d -o 0 -g 0 -m 0700 "$state_dir"
  printf 'doris-studio-gateway-v1\n' > "$state_dir/.managed"
fi

exec 9>"$state_dir/.lock"
flock -n 9 || die '已有一个启动脚本在运行。'

ensure_directory() {
  local path=$1 owner=$2 group=$3 mode=$4
  if [[ -e $path || -L $path ]]; then
    [[ ! -L $path && -d $path && $(stat -c '%u:%g:%a' "$path") == "$owner:$group:$mode" ]] ||
      die "目录 $path 的所有者或权限不匹配。"
  else
    install -d -o "$owner" -g "$group" -m "$mode" "$path"
  fi
}
ensure_directory "$config_dir" 0 1000 750

for file in "$config_dir/Caddyfile" "$config_dir/users.caddy" "$config_backup"; do
  if [[ -e $file || -L $file ]]; then
    [[ -f $file && ! -L $file ]] || die "发现异常文件 $file。"
  fi
done

new_auth=0
[[ -s $config_dir/users.caddy ]] || new_auth=1
configuration_changed=0
config_matches() {
  cmp -s <(printf '%s\n' "$gateway_config") "$config_dir/Caddyfile"
}
if [[ $new_auth == 1 || $rotate == 1 || $replace_gateway == 1 ]] || ! config_matches; then
  configuration_changed=1
  staging=$(mktemp -d "$state_dir/.prepare.XXXXXXXX")
  chown 0:1000 "$staging"
  chmod 0750 "$staging"
  printf '%s\n' "$gateway_config" > "$staging/Caddyfile"
  chown 0:1000 "$staging/Caddyfile"
  chmod 0640 "$staging/Caddyfile"

  if [[ $new_auth == 1 || $rotate == 1 ]]; then
    [[ -t 0 ]] || die '设置密码需要交互式终端。'
    IFS= read -r -p '网页登录名 [studio]：' login
    login=${login:-studio}
    [[ $login =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$ ]] ||
      die '登录名须为 1 到 64 位英文字母、数字或下划线，可在中间使用 . 或 -。'
    IFS= read -r -s -p '网页密码（至少 12 个字符，最多 72 字节）：' password
    printf '\n' >&2
    IFS= read -r -s -p '确认网页密码：' confirmation
    printf '\n' >&2
    [[ $password == "$confirmation" ]] || die '两次输入的密码不一致。'
    unset confirmation
    [[ $password != [[:space:]]* && $password != *[[:space:]] && $password != *[[:cntrl:]]* ]] ||
      die '密码首尾请勿使用空白字符，且不能含控制字符。'
    password_bytes=$(LC_ALL=C printf '%s' "$password" | wc -c)
    [[ ${#password} -ge 12 && $password_bytes -le 72 ]] || die '密码长度不符合要求。'

    hash=$(printf '%s\n' "$password" |
      docker run --rm -i --pull=never --network none --user 1000:1000 \
        --read-only --cap-drop ALL --security-opt no-new-privileges \
        --tmpfs "$caddy_exec_mount" --entrypoint /bin/sh "$gateway_image" \
        -ec "$caddy_bootstrap" caddy hash-password --algorithm bcrypt) ||
      die '无法生成网页密码哈希。'
    unset password
    bcrypt_pattern='^\$2[abxy]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    base64_pattern='^[A-Za-z0-9+/]{80}$'
    [[ $hash =~ $bcrypt_pattern || $hash =~ $base64_pattern ]] || die '未取得有效的 bcrypt 哈希。'
    printf '%s %s\n' "$login" "$hash" > "$staging/users.caddy"
    chown 0:1000 "$staging/users.caddy"
    chmod 0640 "$staging/users.caddy"
    unset hash
  else
    install -o 0 -g 1000 -m 0640 "$config_dir/users.caddy" "$staging/users.caddy"
  fi

  docker run --rm --pull=never --network none --user 1000:1000 --read-only \
    --cap-drop ALL --security-opt no-new-privileges \
    -e XDG_DATA_HOME=/data -e XDG_CONFIG_HOME=/config \
    --tmpfs /data:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700 \
    --tmpfs /config:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700 \
    -v "$staging:/etc/caddy:ro,Z" \
    --tmpfs "$caddy_exec_mount" --entrypoint /bin/sh "$gateway_image" \
    -ec "$caddy_bootstrap" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
    die 'Caddy 配置校验失败。'

  if [[ -s $config_dir/Caddyfile && ! -e $config_backup ]] && ! config_matches; then
    install -o 0 -g 1000 -m 0640 "$config_dir/Caddyfile" "$config_backup"
  fi
  install -o 0 -g 1000 -m 0640 "$staging/Caddyfile" "$config_dir/.Caddyfile.new"
  install -o 0 -g 1000 -m 0640 "$staging/users.caddy" "$config_dir/.users.caddy.new"
  mv -f -- "$config_dir/.Caddyfile.new" "$config_dir/Caddyfile"
  mv -f -- "$config_dir/.users.caddy.new" "$config_dir/users.caddy"
fi

systemctl enable docker
docker update --restart unless-stopped "$app_container" >/dev/null
if [[ $(docker container inspect --format '{{.State.Running}}' "$app_container") != true ]]; then
  docker start "$app_container" >/dev/null
fi

app_ready=0
for ((attempt = 0; attempt < 10; attempt++)); do
  if curl -fsS --noproxy '*' --max-time 2 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
    app_ready=1
    break
  fi
  sleep 1
done
[[ $app_ready == 1 ]] || die "后端未在 127.0.0.1:$port 响应。请运行 docker logs $app_container。"

if [[ $replace_gateway == 1 ]]; then
  gateway_status=$(docker container inspect --format '{{.State.Status}}' "$gateway_id")
  case "$gateway_status" in
    running|restarting) docker container stop "$gateway_id" >/dev/null ;;
    created|exited) ;;
    *) die "现有网关处于 $gateway_status 状态，请检查 docker ps -a。" ;;
  esac
  docker container rm "$gateway_id" >/dev/null
  existing_gateway=0
fi

if [[ $existing_gateway == 0 ]]; then
  docker run -d --pull=never --name "$gateway_container" --restart unless-stopped \
    --label "$managed_label=true" --label "$mode_label=http-v1" --network host --user 1000:1000 --read-only \
    --cap-drop ALL --security-opt no-new-privileges \
    -e XDG_DATA_HOME=/data -e XDG_CONFIG_HOME=/config \
    --tmpfs /data:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700 \
    --tmpfs /config:rw,noexec,nosuid,uid=1000,gid=1000,mode=0700 \
    -v "$config_dir:/etc/caddy:ro,Z" \
    --tmpfs "$caddy_exec_mount" --entrypoint /bin/sh "$gateway_image" \
    -ec "$caddy_bootstrap" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
else
  docker update --restart unless-stopped "$gateway_container" >/dev/null
  gateway_status=$(docker container inspect --format '{{.State.Status}}' "$gateway_container")
  case "$gateway_status" in
    restarting) docker restart "$gateway_container" >/dev/null ;;
    running)
      if [[ $configuration_changed == 1 ]]; then
        docker restart "$gateway_container" >/dev/null
      fi
      ;;
    created|exited) docker start "$gateway_container" >/dev/null ;;
    *) die "现有网关处于 $gateway_status 状态，请检查 docker ps -a。" ;;
  esac
fi

gateway_ready=0
for ((attempt = 0; attempt < 15; attempt++)); do
  status=$(curl -sS --noproxy '*' --max-time 2 \
    -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null) || status=
  if [[ $status == 401 ]]; then
    gateway_ready=1
    break
  fi
  sleep 1
done
[[ $gateway_ready == 1 ]] ||
  die "未通过 HTTP 和登录拦截检查。请运行 docker logs $gateway_container。"

login=$(awk 'NR == 1 {print $1}' "$config_dir/users.caddy")
printf '\n访问地址：%s\n登录名：%s\n' "$url" "$login"
printf 'HTTP 登录口令未加密传输，请在可信内网访问。\n'
printf '检查 Doris 连接（按提示输入网页密码）：\n  curl --noproxy "*" --user %q %q\n' \
  "$login" "$url/api/status"
printf '若客户端连不上，请检查对应网卡的防火墙区域，并从可信客户端放行 TCP %s。\n' "$port"
