# 远程运行 OpenScience 服务端（SSH 隧道 / SSH 连接管理器 / Docker）

OpenScience 的本地 server **只绑定 `127.0.0.1`**——这是设计如此（`backend/cli/src/cli/network.ts:24-27`："The server is loopback-only by design"，配置里的 `server.hostname` / `server.mdns` 会被解析但忽略；绑定写死在 `backend/cli/src/server/server.ts:915`）。因此"远程使用"的固定套路是：

> 在远程主机上跑 `openscience serve --port 4096`，通过 SSH 隧道把远端的回环端口映射到本机的 `127.0.0.1:4096`，桌面端把它当作一个普通服务器地址添加。

下文给出三种方式：手动隧道（A，任何环境都可用）、桌面端 SSH 连接管理器（B，本次新增功能）、Docker 镜像（C，推荐用于远程 GPU 主机）。远程主机需为 Linux x64，且已部署 sidecar 二进制（与 AppImage 同源产物，本地路径 `backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience`）。

---

## A. 手动 SSH 隧道 + `openscience serve`

### A.1 远程侧：让 serve 常驻

**方式一：`systemd --user`（推荐）**

在远程主机的 `~/.config/systemd/user/openscience.service` 写入：

```ini
[Unit]
Description=OpenScience headless server
After=network-online.target

[Service]
Environment=OPENSCIENCE_DATA_DIR=%h/openscience-data
ExecStart=%h/tools/openscience serve --port 4096
Restart=on-failure

[Install]
WantedBy=default.target
```

启用（`enable-linger` 让用户服务不登录也常驻）：

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now openscience
curl http://127.0.0.1:4096/global/health   # 远程本地验证，应返回 {"healthy":true,...}
```

**方式二：tmux（临时用）**

```bash
tmux new -s openscience
openscience serve --port 4096
# Ctrl-b d 脱离；tmux attach -t openscience 回来
```

### A.2 本地侧：建立隧道

```bash
ssh -N -L 4096:127.0.0.1:4096 gpu-host
```

- `-N` 只做转发不开 shell；`-L 4096:127.0.0.1:4096` 把**远端回环**的 4096 映射到本机 4096。
- 建议加 `ExitOnForwardFailure=yes`（端口被占时报错退出而不是静默不转发）和保活参数（见 F.1）。
- 保持这个终端开着；验证：`curl http://127.0.0.1:4096/global/health`。

### A.3 桌面端连接

桌面 **Customize → Servers**，点 **Add server**，输入 `http://127.0.0.1:4096`。对话框会立即做健康探测（绿点=可达，`frontend/workspace/src/components/dialog-select-server.tsx:56-71`），保存后每 10 秒轮询一次状态（`dialog-select-server.tsx:330-335`）。条目菜单里可 **Set as default**，启动时直接连该服务器而不起本地 server（需重启应用生效）。

---

## B. 桌面端 SSH 连接管理器（本次新功能）

连接管理器把 A 节的手工步骤收敛到桌面里：维护一份 SSH 主机配置（主机、用户、密钥来源），一键建立并维持到远端的隧道，然后把隧道落在的 `http://127.0.0.1:4096` 注册进 Servers 列表。典型流程：

1. 打开连接管理器，添加主机（地址 / 用户 / 密钥），先做一次连通性测试；
2. 连接后由桌面负责隧道建立与断线重连，远端侧不需要你手动放 systemd/tmux（用 docker 的话见 C 节，服务端仍然在远程主机上以容器常驻）；
3. 连接成功后，Servers 对话框里会出现 `http://127.0.0.1:4096`，状态点变绿即可使用，后续切换与设为默认与 A.3 相同。

具体入口与字段以随本功能发布的实际界面为准。底层语义与 A 节完全一致：远端 server 只监听远端回环，隧道是唯一通道。

---

## C. Docker（本地 / 远程 GPU 主机）

### C.1 构建镜像

```bash
bash docker/build-runtime.sh
```

脚本会检查 `backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience`（缺失时给出重建指引：`bun run --cwd backend/cli build`），把二进制暂存进临时 `sidecar/` 构建上下文（构建后自动清理），产出镜像 `openscience-runtime:local`。镜像内非 root 用户 `openscience`（uid/gid 1000）运行，数据目录 `/data`（`ENV OPENSCIENCE_DATA_DIR=/data`），见 `docker/Dockerfile.runtime`。

### C.2 为什么必须 `--network host`

服务端在容器里同样只绑定容器自身的 `127.0.0.1`。Docker 的端口发布（`-p`）把流量转给**容器的 eth0**，而服务只监听容器回环，永远不通。本机实测（Docker 26.1.5）：

```
docker run -p 127.0.0.1:18096:18096 ... python3 -m http.server 18096 --bind 127.0.0.1
curl http://127.0.0.1:18096/    # curl: (56) Recv failure: 连接被对方重置
docker run --network host ... python3 -m http.server 18097 --bind 127.0.0.1
curl http://127.0.0.1:18097/    # HTTP 200
```

所以运行镜像要用 `--network host`（Linux 宿主）：容器与宿主共享网络命名空间，容器内的 `127.0.0.1:4096` 就是宿主的 `127.0.0.1:4096`，"仅回环可访问"的安全边界不变。若未来 server 增加绑定地址选项，才可以用 `-p` 写法。

### C.3 运行

```bash
# 本地
docker run --rm --init --network host \
  -v "$PWD/openscience-data:/data" \
  openscience-runtime:local
curl http://127.0.0.1:4096/global/health
```

```bash
# 远程 GPU 主机（要求宿主已装 NVIDIA Container Toolkit，见下）
ssh gpu-host 'docker run -d --rm --init --network host --gpus all \
  -v ~/openscience-data:/data \
  openscience-runtime:local'
ssh -N -L 4096:127.0.0.1:4096 gpu-host      # 本地隧道，随后按 A.3 连接
```

- **GPU 前提**：远程宿主需安装 `nvidia-container-toolkit` 并把 docker 配置为 nvidia runtime（`sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`）；可用 `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` 冒烟。无 GPU 的机器去掉 `--gpus all`。
- `-v ...:/data` 让会话、凭据、项目跨容器重启保留；不要挂载就得到一次性服务。
- 目标机没有构建上下文时迁移镜像：`docker save openscience-runtime:local | ssh gpu-host 'docker load'`。

---

## D. 安全注意

1. **服务端固定 `127.0.0.1`**：没有任何 flag / 环境变量能改绑定地址（`backend/cli/src/cli/network.ts:24-27`），不存在"误听公网"的配置路径。
2. **不要公网直连**：不要在远程主机防火墙开放 4096，也不要把它挂在反代/公网 IP 上。服务没有为公网暴露设计的鉴权层，公网可回环 = 任何人可控制你的会话。
3. **隧道是默认安全边界**：谁能 ssh 到远程主机，谁才能用这个服务。`-L 4096:127.0.0.1:4096` 只转发远端回环，宿主外部接口上的流量到不了服务。
4. **远程主机需自配模型 key**：凭据存在服务端数据目录的 `auth.json`（`backend/cli/src/auth/index.ts:56`），远程 server 不会复用你本机的 key。连接远端 server 后在 Customize 的 Provider keys / 凭据页配置，或把本机 `<data>/auth.json` 拷贝过去。模型请求由远端 server 发出，走的也是远端的网络。
5. **权限模式同样生效**：项目级 `Ask always / Ask risky / Full access`（`ProjectAccess`，CHANGES.md 任务 3）在远程会话中一致；`Full access` 会跳过日常工具确认，切换时保留一次确认对话框，且显式 `deny` 规则与付费远程计算的预算审批仍会询问。

---

## E. 断网语义、权限等待与 server 重启

- **断网**：桌面每 10 秒探测 server 健康（`dialog-select-server.tsx:330-335`），确认不可达后显示"Can't reach your local OpenScience server"横幅（`frontend/workspace/src/atlas/DisconnectedPanel.tsx:8-13`），恢复后自动消失。会话与项目数据都在服务端数据目录，客户端只是视图——隧道断开不丢数据，但断线期间发出的消息不会自动补发，恢复后重试或新开会话。
- **权限等待**：被询问的权限由服务端持有，`ask` / `approve` 模式下工具调用会停下等待批准；页面关闭、重连不影响服务端等待状态，审批结果持久化在数据目录。`full` 模式跳过日常确认（边界见 D.5）。
- **server 重启**：SIGTERM 触发优雅停机，服务管理器场景最长 12 秒（`backend/cli/src/cli/server-stop.ts:10`），desktop sidecar 场景 4 秒（`server-stop.ts:18`）。重启后会话、项目、凭据均在 `/data` / `OPENSCIENCE_DATA_DIR` 中；桌面健康探测会自动重连；进行中的终端/WebSocket 连接会提示中断（对应 i18n "terminal connection was interrupted…"）。systemd unit 配了 `Restart=on-failure` 即自动拉起。

---

## F. 常见问题排查

**F.1 隧道断开** — 横幅出现 + Servers 列表红点。先确认本机 ssh 进程还在、远端 serve 还活着（`ssh gpu-host 'curl -s http://127.0.0.1:4096/global/health'`）。长期稳定建议：`ServerAliveInterval 30` + `ServerAliveCountMax 3` 保活、`ExitOnForwardFailure=yes`，或用 autossh / systemd --user 单元管理隧道。注意本机 4096 若被你自己的本地 server 占用，换 `-L 4097:127.0.0.1:4096` 并在 Servers 里加 `http://127.0.0.1:4097`。

**F.2 远程磁盘** — 数据目录会随会话、工具产物、日志增长，先 `du -sh ~/openscience-data` 定位；磁盘满时 server 写入会失败、会话保存异常。迁移位置即改 `OPENSCIENCE_DATA_DIR`（显式覆盖优先于指针文件，`backend/cli/src/global/index.ts:61-78`），Docker 场景换掉 `-v` 挂载即可。

**F.3 版本升级** — 重新构建 sidecar（`bun run --cwd backend/cli build`）后：二进制部署直接替换并重启服务；Docker 场景重跑 `bash docker/build-runtime.sh` 并在远端重新 `docker run`（或 `docker save | ssh gpu-host 'docker load'`）。桌面 Servers 对话框会在条目上显示 server 版本徽章（`dialog-select-server.tsx:627-634`），也可对照 `curl http://127.0.0.1:4096/global/health` 里的 `version` 字段。远端与桌面差异过大时建议两端一起升。

**F.4 4096 被占用** — 显式传了 `--port` 时端口不可用会直接启动失败（`backend/cli/src/server/server.ts:929-930`），看服务日志报错即可；换端口后，桌面 Servers 里的 URL 同步改。

**F.5 健康检查** — 任何一步卡住先跑 `curl http://127.0.0.1:4096/global/health`：在**远端本机**跑验证服务侧，在**本地**跑验证隧道侧，两边对照即可定位问题在哪一段（本文档撰写时已在本地实测：返回 `{"healthy":true,"version":"2.0.153-local.1",...}`）。
