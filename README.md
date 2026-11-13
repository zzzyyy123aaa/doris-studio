# Doris Studio

Doris Studio 是 Apache Doris 的中文可视化管理页面。内网版支持连接并切换多个 Doris 数据源，浏览库表和字段、预览数据、运行只读 SQL、导出 CSV，以及查看集群指标和配置飞书告警。演示版使用内置样本。

## 本地演示

在没有 `.env` 和 `DORIS_*` 环境变量的项目目录中，用 Node.js 22 或更新版本启动。演示无需安装数据库驱动。浏览器打开 `http://127.0.0.1:4173`，也可将 `dist/` 作为静态站点托管。

```sh
node server.mjs
```

演示中的 SQL 工作台支持简单查询和元数据命令。保存的 SQL、查询记录和偏好存于当前浏览器。

## Docker 内网部署

部署目标为 `linux/amd64`。Linux 宿主机需要 Docker Engine，并能访问 Doris FE 的查询端口。应用容器使用主机网络，监听宿主机的 `127.0.0.1:4173`。网关和升级脚本使用这个端口，请保留 `STUDIO_PORT=4173`。在 CentOS 7 等使用 `3.10` 内核的服务器上，先按下文验证镜像能启动，Node.js 22 的 Linux x64 musl 构建对这个内核基线属于实验性支持。 [Docker 主机网络](https://docs.docker.com/engine/network/drivers/host/) · [Node.js 平台要求](https://github.com/nodejs/node/blob/v22.23.4/BUILDING.md#platform-list)

### 构建和传输镜像

在可访问 Docker Hub 和 npm 仓库的构建机上克隆本仓库并构建。若部署服务器可联网并具备构建条件，也可直接在服务器完成这一节。

```sh
git clone https://github.com/zzzyyy123aaa/doris-studio.git
cd doris-studio
docker build --platform linux/amd64 -t doris-studio:1.0.0 .
```

需要使用本仓库的 HTTP 网关时，将 Caddy 镜像标记成网关脚本使用的名称。公司已有反向代理时，可以直接使用下文的域名接入方式。 [Caddy 官方镜像](https://hub.docker.com/_/caddy)

```sh
docker pull --platform linux/amd64 caddy:2.11.7-alpine
docker tag caddy:2.11.7-alpine doris-studio-gateway:1.0.0
```

若部署服务器无法访问镜像仓库，在构建机上导出所需镜像。把生成的 tar 文件和本仓库源码传到部署服务器，再执行 `docker load`。使用网关时执行第二组命令。

```sh
# 构建机
docker save -o doris-studio-linux-amd64.tar doris-studio:1.0.0
# 部署服务器
docker load -i doris-studio-linux-amd64.tar
```

```sh
# 构建机
docker save -o doris-studio-gateway-linux-amd64.tar doris-studio-gateway:1.0.0
# 部署服务器
docker load -i doris-studio-gateway-linux-amd64.tar
```

部署服务器上的镜像自检无需连接 Doris 或外网。

```sh
docker run --rm --pull=never --network none doris-studio:1.0.0 node --version
```

### 首次启动

在部署服务器创建配置文件。在编辑器中填写 Doris 连接信息和密码。下表说明各项配置，文件应留在部署服务器。

```sh
umask 077
cp -n .env.example .env
chmod 600 .env
vi .env
```

启动应用并挂载持久化卷。这个卷保存新增数据源、监控历史、告警规则和飞书设置。已有同名容器时，请使用下文的升级流程。

```sh
docker volume create doris-studio-monitoring
docker run -d --pull=never --name doris-studio --restart unless-stopped \
  --network host --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file .env \
  --mount type=volume,source=doris-studio-monitoring,target=/app/monitoring-data \
  doris-studio:1.0.0

docker logs --tail 30 doris-studio
curl --noproxy '*' --max-time 20 http://127.0.0.1:4173/api/status
```

状态接口返回 `"mode":"live"` 和 `"connected":true` 后，在 SQL 工作台运行 `SELECT 1;` 验证连接。

### 内网 HTTP 网关

在部署服务器的交互式终端执行以下命令。网关仅绑定输入的本机内网 IPv4 地址。首次运行时，按提示创建网页登录名和密码，再打开脚本输出的 `http://内网IP:4173`。脚本会启用 Docker 开机启动，并设置两个容器随 Docker 自动启动。

```bash
read -r -p '请输入本机内网 IPv4 地址：' studio_lan_ip
sudo env DORIS_STUDIO_GATEWAY_IP="$studio_lan_ip" bash gateway/start.sh
```

登录口令与 Doris 连接密码分别配置。HTTP 会明文传输网页登录、查询和提交的凭据。将 TCP `4173` 的访问范围限制在可信内网，填写 Doris 或飞书凭据时可使用下面的 SSH 隧道或 HTTPS 入口。重新设置网页登录口令时，为上述命令加上 `--rotate-password`。

### SSH 和域名访问

临时访问可从客户端建立 SSH 隧道。替换用户名和主机名后执行，并保持终端连接。浏览器打开 `http://127.0.0.1:4173`。

```sh
ssh -N -L 4173:127.0.0.1:4173 user@studio-server.example.internal
```

团队使用域名时，在公司内网 DNS 中配置域名，由公司 HTTPS 反向代理提供证书和身份验证。将页面和 `/api/` 一起转发。如果代理与 Studio 同机，可将上游设为 `http://127.0.0.1:4173`，并将上游 `Host` 设为 `127.0.0.1:4173`。如果代理在另一台机器，可转发至内网网关地址，将上游 `Host` 设为该网关的 `IP:4173`，并保留网关所需的 Basic 登录认证。部署完成后验证未登录访问会收到认证提示。 [Caddy Basic 认证](https://caddyserver.com/docs/caddyfile/directives/basic_auth)

### 升级和回滚

按上文从新源码构建并导出 `doris-studio:1.0.0`，把镜像 tar 传到部署服务器。升级脚本适用于正在运行、已连通 Doris、采用标准容器名称和主机网络的部署。它复用现有 `.env` 和 `doris-studio-monitoring` 卷。如果已有额外挂载，例如私有 CA 证书，请按原容器配置手动替换。建议升级前按现有运维流程备份 `.env` 和数据卷，备份按凭据文件保管。

```sh
sudo bash deploy/container/upgrade-cluster.sh /path/to/deployment/.env /path/to/doris-studio-linux-amd64.tar
```

脚本会导入镜像，预检数据卷并短暂停机切换容器。应用接口检查失败时会尝试恢复原容器。成功后，脚本会打印保留的旧容器名，其状态为已停止，自动重启已关闭。网关继续使用原来的回环上游。

若需在升级成功后回滚，先确认旧容器和共享数据卷可用。输入升级脚本打印的旧容器名，并确保下面用于保留新版容器的名称尚未使用。以下命令恢复旧容器及标准重启策略。

```bash
read -r -p '请输入升级脚本打印的备份容器名：' backup
rollback_copy=doris-studio-after-upgrade

[[ "$backup" == doris-studio-backup-* ]] &&
  [[ $(docker container inspect --format '{{.State.Running}}' "$backup") == false ]] &&
  ! docker container inspect "$rollback_copy" >/dev/null 2>&1 &&
  docker update --restart=no doris-studio &&
  docker stop doris-studio &&
  docker rename doris-studio "$rollback_copy" &&
  docker rename "$backup" doris-studio &&
  docker start doris-studio &&
  docker update --restart=unless-stopped doris-studio &&
  docker image tag "$(docker inspect --format '{{.Image}}' doris-studio)" doris-studio:1.0.0

curl --noproxy '*' --max-time 20 http://127.0.0.1:4173/api/status
```

容器回滚会继续使用旧容器原有挂载。若需恢复升级前的数据内容，请使用升级前的卷备份。

## 连接配置

| 变量 | 含义 |
| --- | --- |
| `DORIS_HOST` | 默认数据源的 Doris FE 地址，填写内网 IP 或主机名 |
| `DORIS_PORT` | FE MySQL 查询端口，默认 `9030` |
| `DORIS_USER` | Doris 只读账号 |
| `DORIS_PASSWORD` | 该账号的密码，Docker `--env-file` 中按原值填写 |
| `DORIS_DATABASE` | 默认业务库，新集群可留空 |
| `DORIS_TLS` | FE 配置了 MySQL TLS 时填写 `true` |
| `DORIS_TLS_CA_FILE` | 可选私有 CA 文件。容器部署时填写只读挂载后的容器内路径 |
| `STUDIO_PORT` | 页面回环监听端口，默认 `4173` |
| `STUDIO_MONITORING_DIR` | 数据目录。Docker 标准部署使用 `/app/monitoring-data`，直接运行 Node 时可指定绝对路径 |

`.env` 中的连接作为默认数据源。「数据源管理」可添加、切换和重命名连接。新增时会验证 Doris 连接，重命名只改变显示名称。访问同一部署的浏览器共享服务端连接和权限，各浏览器独立记住所选数据源。标准容器部署将新增连接保存到数据卷的 `sources/sources.json`，飞书配置保存到 `alerts/webhook.json`，文件权限均为 `0600`。请将数据卷及其备份按凭据文件管理。

也可直接在 Linux 上运行内网版。可以使用与容器一致的 Node.js 22.23.4 和 pnpm 11.25.0。创建 `.env` 后执行以下命令。为保留监控历史，请设置 `STUDIO_MONITORING_DIR` 指向运行账号可写的目录。 [pnpm 安装文档](https://pnpm.io/installation)

```sh
pnpm install --prod --frozen-lockfile --ignore-scripts
node server.mjs
```

## Doris 权限与监控

请由 Doris 管理员创建只读服务账号，将登录来源限制为 Studio 服务器，并为需要查看的库表授予 `SELECT_PRIV`。库表、数据预览和查询结果以该账号权限为准。SQL 工作台支持单条只读查询及受支持的元数据语句。 [Doris 创建账号](https://doris.apache.org/zh-CN/docs/4.x/sql-manual/sql-statements/account-management/CREATE-USER/) · [Doris 授权](https://doris.apache.org/zh-CN/docs/4.x/sql-manual/sql-statements/account-management/GRANT-TO/)

- **Doris 4.x** 的节点查询使用 `internal.information_schema` 的 `SELECT_PRIV`。应用通过 FE 和 BE 上报的 HTTP 端口访问 `/metrics`，常见端口为 FE `8030` 和 BE `8040`。 [FE 节点](https://doris.apache.org/docs/4.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-FRONTENDS/) · [BE 节点](https://doris.apache.org/docs/4.x/sql-manual/sql-statements/cluster-management/instance-management/SHOW-BACKENDS/) · [监控指标](https://doris.apache.org/docs/4.x/admin-manual/maint-monitor/metrics/)
- **Doris 2.1.8 和 2.1.11** 的 `SHOW FRONTENDS` 与 `SHOW BACKENDS` 要求全局 `ADMIN_PRIV` 或 `NODE_PRIV`。保留只读账号时，应用从可访问的 FE `8030` 上的 `/api/health` 或 `/metrics` 获取可用汇总。如果 FE 指标提供完整 BE 地址，应用尝试采集 BE 默认 `8040` 上的 `/metrics`。页面会标明当前 FE 指标与 BE HTTP 采集覆盖，缺少权限的节点明细及心跳显示为未知。 [Doris 2.1 健康接口](https://doris.apache.org/docs/2.1/admin-manual/open-api/fe-http/health-action/) · [Doris 2.1 监控指标](https://doris.apache.org/docs/2.1/admin-manual/maint-monitor/metrics/)

监控约每 30 秒采样，历史从首次采样起累计并保留最近 30 天。CPU 和网络速率需要连续两轮样本，平均查询耗时是 FE 采样估算。遇到权限、认证或连通性限制时，未采集到的指标和历史缺口留空。多个存储根目录可能共用磁盘时，兼容采集保留 Doris 数据占用，并将无法确认的磁盘总容量留空。

## 飞书告警

在「管理 → 告警配置」保存「全局飞书机器人」。填写目标群的自定义机器人 HTTPS Webhook，开启签名校验时同时填写密钥。保存后可点击发送测试消息。服务器需要能通过 HTTPS 访问 `open.feishu.cn:443`。若机器人启用了关键词，可以使用通知中包含的 `Doris Studio`。 [飞书自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN)

每个数据源独立设置阈值、连续采样次数、冷却时间和恢复通知，所有数据源共用全局机器人。阈值留空会关闭相应规则。已启用告警的数据源在应用重启后自动开始采样。通知含数据源名称，已通知的告警在取得恢复样本后才会发送恢复消息。

旧版数据源的机器人配置会继续使用，直到第一次保存全局配置。旧凭据一致时可在页面确认沿用，存在多个机器人时需填入统一地址。清除全局机器人会暂停飞书通知。

## 开发检查

前端运行文件位于 `dist/`，Node 服务入口为 `server.mjs`，Doris 接入、监控和告警模块位于 `server/`。

```sh
node --run check
bash -n gateway/start.sh
bash -n deploy/container/upgrade-cluster.sh
```
