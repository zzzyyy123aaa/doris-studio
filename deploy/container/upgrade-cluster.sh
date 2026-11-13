#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

app=doris-studio
image=doris-studio:1.0.0
upgrade_label=io.doris-studio.upgrade-id
monitoring_volume=doris-studio-monitoring
monitoring_dir=/app/monitoring-data
monitoring_mount="type=volume,source=$monitoring_volume,target=$monitoring_dir"
script_dir=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
archive=${2:-"$script_dir/doris-studio-linux-amd64.tar"}

die() {
  printf '升级失败：%s\n' "$*" >&2
  exit 1
}

docker_local() {
  command docker --host unix:///var/run/docker.sock "$@"
}

container_info() {
  docker_local container inspect --format "$1" "$2" 2>/dev/null
}

image_id() {
  docker_local image inspect --format '{{.Id}}' "$1" 2>/dev/null
}

quiet_docker() {
  docker_local "$@" >/dev/null 2>&1
}

# Run the health check from the host-network container. Only the exit code is used.
probe() {
  docker_local exec -i "$1" node - "$2" "$3" >/dev/null 2>&1 <<'JS'
const origin = 'http://127.0.0.1:4173';
const deadline = Date.now() + Number(process.argv[3]) * 1000;
async function json(path, limit) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('deadline');
  const response = await fetch(origin + path, {
    redirect: 'error', signal: AbortSignal.timeout(Math.min(remaining, limit)),
  });
  if (response.status !== 200) throw new Error('http');
  return response.json();
}
(async () => {
  while (Date.now() < deadline) {
    try {
      const status = await json('/api/status', 12_000);
      if (status?.mode !== 'live' || status.connected !== true) throw new Error('status');
      if (process.argv[2] === 'monitoring') {
        const cluster = await json('/api/cluster', 25_000);
        if (!cluster || typeof cluster.sampledAt !== 'string' || !cluster.sampledAt ||
            !Array.isArray(cluster.frontends?.nodes) || !Array.isArray(cluster.backends?.nodes)) {
          throw new Error('cluster');
        }
        const monitoring = await json('/api/monitoring', 5_000);
        if (!['ok', 'partial', 'unavailable'].includes(monitoring?.sourceStatus) ||
            !monitoring.current || !Array.isArray(monitoring.history)) throw new Error('monitoring');
        const sources = await json('/api/sources', 5_000);
        if (!Array.isArray(sources?.sources) || typeof sources.defaultId !== 'string') throw new Error('sources');
        const alerts = await json('/api/alerts', 5_000);
        if (typeof alerts?.config?.enabled !== 'boolean' || !Array.isArray(alerts?.status?.active)) throw new Error('alerts');
        const webhook = await json('/api/alerts/webhook', 5_000);
        if (typeof webhook?.globalConfigured !== 'boolean' || typeof webhook?.webhookConfigured !== 'boolean') throw new Error('webhook');
      }
      return;
    } catch {
      const delay = Math.min(1500, deadline - Date.now());
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  process.exitCode = 1;
})().catch(() => { process.exitCode = 1; });
JS
}

if [[ $# == 1 && ( $1 == -h || $1 == --help ) ]]; then
  printf '用法：sudo bash %q [现有 .env 路径] [镜像 tar 路径]\n' "$0"
  exit 0
fi
[[ $# -le 2 ]] || die '只接受现有 .env 和镜像 tar 路径。'
[[ $EUID == 0 ]] || die '请在应用服务器上以 root 身份运行此脚本。'
for tool in docker flock grep date; do
  command -v "$tool" >/dev/null || die "缺少命令 $tool。"
done

env_file=${1:-.env}
[[ -f $env_file && -r $env_file ]] || die '找不到可读的现有 .env 文件。'
[[ -f $archive && -r $archive ]] || die "找不到可读的镜像包：$archive"

exec 9>>/run/doris-studio-upgrade.lock
flock -n 9 || die '另一项 Doris Studio 升级正在运行。'
quiet_docker info || die '无法访问本机 Docker Engine。'

old_info=$(container_info '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.RestartPolicy.MaximumRetryCount}}|{{len .Mounts}}' "$app") ||
  die '找不到现有 doris-studio 容器。'
IFS='|' read -r old_id old_image old_tag old_running old_network old_restart old_retry_count old_mounts <<< "$old_info"
[[ $old_id =~ ^[a-f0-9]{64}$ && $old_image =~ ^sha256:[a-f0-9]{64}$ && $old_tag == "$image" && $old_running == true && $old_network == host ]] ||
  die '需要正在运行、使用 doris-studio:1.0.0 和 host 网络的现有容器。'
if [[ $old_mounts != 0 ]]; then
  old_mount=$(container_info '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}|{{.RW}}{{end}}' "$old_id")
  [[ $old_mounts == 1 && $old_mount == "volume|$monitoring_volume|$monitoring_dir|true" ]] ||
    die '现有容器有额外挂载，需要按原配置手动升级。'
fi
case "$old_restart" in
  ''|no) old_restart=no ;;
  always|unless-stopped) ;;
  on-failure)
    [[ $old_retry_count =~ ^[0-9]+$ ]] || die '无法确认现有重启策略。'
    if [[ $old_retry_count != 0 ]]; then old_restart="on-failure:$old_retry_count"; fi ;;
  *) die '无法确认现有重启策略。' ;;
esac
probe "$old_id" status 20 || die '现有容器的 /api/status 未确认已连接 Doris。'

original_tag=$(image_id "$image" || true)
upgrade_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup="$app-backup-$upgrade_id"
stage="$app-next-$upgrade_id"
new_id=
loaded=0
replacing=0
committed=0

cleanup() {
  local result=$? owned_info owned_id owner current_name running restored=1
  trap - EXIT
  trap '' INT TERM
  if [[ $committed == 1 ]]; then return; fi
  set +e

  # Remove only a container bearing this invocation's ownership label.
  owned_info=$(container_info '{{.Id}}|{{index .Config.Labels "io.doris-studio.upgrade-id"}}' "${new_id:-$stage}")
  IFS='|' read -r owned_id owner <<< "$owned_info"
  if [[ $owner == "$upgrade_id" && $owned_id =~ ^[a-f0-9]{64}$ ]]; then
    quiet_docker container rm -f "$owned_id" || printf '无法移除本次创建的替换容器。\n' >&2
  fi

  if [[ $replacing == 1 ]]; then
    current_name=$(container_info '{{.Name}}' "$old_id")
    if [[ $current_name != "/$app" ]]; then
      quiet_docker container rename "$old_id" "$app" || restored=0
    fi
    if [[ $restored == 1 ]]; then
      running=$(container_info '{{.State.Running}}' "$old_id")
      if [[ $running != true ]]; then quiet_docker container start "$old_id" || restored=0; fi
      quiet_docker container update --restart="$old_restart" "$old_id" || restored=0
      quiet_docker image tag "$old_image" "$image" || restored=0
    fi
    if [[ $restored == 1 && $(container_info '{{.State.Running}}' "$old_id") == true ]]; then
      printf '已恢复原容器 doris-studio 及其重启策略。\n' >&2
    else
      printf '自动恢复未完成。请检查原容器 %s（备份名 %s）和 Docker 状态。\n' "$old_id" "$backup" >&2
    fi
  elif [[ $loaded == 1 && -n $original_tag ]]; then
    quiet_docker image tag "$original_tag" "$image" || printf '无法恢复升级前的镜像标签。\n' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '导入离线镜像，现有应用继续运行。\n'
loaded=1
load_output=$(docker_local image load --quiet --input "$archive" 2>/dev/null) || die 'Docker 无法导入离线镜像。'
grep -Fxq "Loaded image: $image" <<< "$load_output" || die '离线镜像包不包含 doris-studio:1.0.0。'
loaded_image=$(image_id "$image") || die '导入后找不到预期镜像标签。'
[[ $loaded_image =~ ^sha256:[a-f0-9]{64}$ ]] || die '无法确认新镜像 ID。'
if [[ $loaded_image == "$old_image" && $old_mounts == 1 ]]; then
  probe "$old_id" monitoring 30 || die '运行容器已使用包中的镜像，但服务接口未通过检查。'
  committed=1
  printf '当前监控镜像已部署，服务检查通过。\n'
  exit 0
fi
[[ $(docker_local image inspect --format '{{.Os}}/{{.Architecture}}' "$loaded_image" 2>/dev/null) == linux/amd64 ]] ||
  die '离线镜像平台须为 linux/amd64。'
quiet_docker run --rm --pull=never --network none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --mount "$monitoring_mount" "$loaded_image" node -e \
  'const fs = require("node:fs"); const dir = fs.mkdtempSync(process.env.STUDIO_MONITORING_DIR + "/.check-"); fs.rmdirSync(dir)' ||
  die '新镜像无法启动 Node.js 或写入监控历史卷。'

new_id=$(docker_local container create --pull=never --name "$stage" --restart=no \
  --label "$upgrade_label=$upgrade_id" --network host --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --env-file "$env_file" --mount "$monitoring_mount" \
  --env "STUDIO_MONITORING_DIR=$monitoring_dir" "$image" 2>/dev/null) ||
  die '无法创建替换容器，请检查 .env 格式和 Docker 配置。'
[[ $new_id =~ ^[a-f0-9]{64}$ && $(container_info '{{.Image}}' "$new_id") == "$loaded_image" ]] ||
  die '无法确认替换容器使用了刚导入的镜像。'
[[ $(container_info '{{.Id}}|{{.State.Running}}' "$app") == "$old_id|true" ]] ||
  die '预检查后现有容器发生变化，请重新检查。'

printf '切换应用容器并检查 Doris 连接。\n'
replacing=1
quiet_docker container update --restart=no "$old_id" || die '无法禁用原容器的自动重启。'
quiet_docker container stop --time 15 "$old_id" || die '无法停止原容器。'
quiet_docker container rename "$old_id" "$backup" || die '无法保留原容器作为备份。'
quiet_docker container rename "$new_id" "$app" || die '无法给替换容器设置应用名称。'
quiet_docker container start "$new_id" || die '新容器启动失败。'
probe "$new_id" monitoring 60 || die '新容器的连接、监控、数据源或告警接口未通过检查。'
[[ $(container_info '{{.Id}}|{{.State.Running}}' "$app") == "$new_id|true" ]] || die '新容器未保持运行。'
quiet_docker container update --restart=unless-stopped "$new_id" || die '无法设置新容器的重启策略。'
committed=1
printf '升级成功。旧容器 %s 已停止并保留，其自动重启已关闭。\n' "$backup"
