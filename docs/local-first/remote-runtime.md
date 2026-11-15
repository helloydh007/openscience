# 远程运行 OpenScience 服务端（SSH 隧道 / SSH 连接管理器 / Docker）

OpenScience 的本地 server **只绑定 `127.0.0.1`**——这是设计如此（`backend/cli/src/cli/network.ts:24-27`："The server is loopback-only by design"，配置里的 `server.hostname` / `server.mdns` 会被解析但忽略；绑定写死在 `backend/cli/src/server/server.ts:915`）。因此"远程使用"的固定套路是：

> 在远程主机上跑 `openscience serve --port 4096`，通过 SSH 隧道把远端的回环端口映射到本机的 `127.0.0.1:4096`，桌面端把它当作一个普通服务器地址添加。

下文给出三种连接方式与若干配套主题：手动隧道（A，任何环境都可用）、桌面端 SSH 连接管理器（B）、运行时模式与本地扩展同步（C，连接管理器的进阶用法）、Docker 镜像（D，推荐用于远程 GPU 主机）；其后是安全注意（E）、断网语义与 server 重启（F）以及常见问题排查（G）。远程主机需为 Linux x64，且已部署 sidecar 二进制（与 AppImage 同源产物，本地路径 `backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience`）。

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
- 建议加 `ExitOnForwardFailure=yes`（端口被占时报错退出而不是静默不转发）和保活参数（见 G.1）。
- 保持这个终端开着；验证：`curl http://127.0.0.1:4096/global/health`。

### A.3 桌面端连接

桌面 **Customize → Servers**，点 **Add server**，输入 `http://127.0.0.1:4096`。对话框会立即做健康探测（绿点=可达，`frontend/workspace/src/components/dialog-select-server.tsx:56-71`），保存后每 10 秒轮询一次状态（`dialog-select-server.tsx:330-335`）。条目菜单里可 **Set as default**，启动时直接连该服务器而不起本地 server（需重启应用生效）。

---

## B. 桌面端 SSH 连接管理器（本次新功能）

入口：首页右上角服务器胶囊（`● Local server`）→「服务器」对话框 → 底部 **SSH servers** 区块；命令面板（Ctrl/Cmd+K）搜 **Switch server** 也能打开。该区块只在打包的桌面端出现（依赖 preload 桥），浏览器标签页里没有。

### B.1 自动导入 `~/.ssh/config`

打开对话框时就会读取当前用户的 `~/.ssh/config`，把 `Host` 别名直接列出来（带 `~/.ssh/config` 徽标，只读）：

- 支持 `HostName` / `User` / `Port` / `IdentityFile`、`Key=value` 写法、引号值，以及 `Include`（`~`、相对 `~/.ssh`、通配符、嵌套，均有深度/文件数上限）。
- 通配符 Host（如 `Host *`）与 `Match` 块**不导入**：它们描述默认值或条件，不是可直接连接的别名；同名别名取第一次声明，与 OpenSSH 的 first-match 规则一致。
- 导入项只读：要改/删请改 `~/.ssh/config`；点 **Sync** 可立即重新读取（每次打开对话框也会自动刷新）。
- 手工添加的记录优先：同 label、或同 host/user/port 的手工记录会遮蔽对应的导入项。
- 连接时只把**别名**交给 ssh（`ssh lab`），`HostName`/`User`/`Port`/`ProxyJump`/`IdentityFile` 全部由 OpenSSH 自己解析，因此 `IdentitiesOnly`、跳板机等配置保持原语义。

### B.2 对面没装 OpenScience 时自动安装（本地自用版）

连接时桌面会探测远端，并在下面任一条件成立时部署：

- `~/.openscience/remote/BUILD` 不存在；或
- 标记里的版本与桌面版本不同；或
- 标记里的 sha256 与**桌面自带 sidecar** 的 sha256 不同（同版本号但字节不同，例如上游发行版，也会被替换）。

部署过程：把桌面自己的 sidecar 通过 SSH stdin 流式写入远端 staging → `mv` 到 `~/.openscience/remote/bin/openscience` → `sha256sum` 校验远端字节与本地构建一致 → 写 `BUILD`（`<version> <sha256> local-bundled`）和 `VERSION`。**不会从 GitHub 或任何下载源拉取**，远端跑的就是本机这个无遥测构建；校验不一致会直接报错，不会启动隧道。

远端 server 以 `setsid nohup` 常驻（日志 `~/.openscience/remote/server.log`，PID `server.pid`），要求远端有 `curl`。断开隧道**不会**停止远端 server，退出桌面也不会——这是为了让长任务在本地断网/关机后继续跑；要停就 `ssh <host> 'kill "$(cat ~/.openscience/remote/server.pid)"'`。

**端口被别的服务占用时**（本机 `agentbox` 上的真实案例：远端 4096 早已跑着旧的上游 OpenScience 2.0.153，打开后会显示账号登录页）：

- 桌面会读该端口监听进程的 `/proc/<pid>/exe`，只有 `~/.openscience/remote/bin/openscience` 才算"自己部署的那份"；健康检查通过但进程不是自己的**不算**成功，不会把隧道接过去。
- 端口被占用时不会去动对方：自动在 `4096` 之后找一个空闲端口（如 `4097`）启动本构建，并把选中的端口写回连接记录，下次连接直接复用；界面会提示 `Port 4096 … is already used by another OpenScience (2.0.153); using port 4097`。
- 远端 server 以 `OPENSCIENCE_DATA_DIR=$HOME/.openscience/remote/data` 和同目录下的 `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME` 启动：既不读宿主上其它 OpenScience 安装的配置，也不要求 `~/.config` 可写（容器里 `~/.config` 常是 root 所有，直接启动会 `EACCES`）。

实测（本机配置的 `debain`，Linux x86_64）：连接后 `/global/health` 返回 `version: 2.0.153-local.2`，远端 `sha256sum` 与本地 sidecar 完全一致。`agentbox`（4096 被上游 2.0.153 占用）：自动切到 4097，健康返回 `2.0.153-local.1`，远端窗口直接是 Projects 页，无登录。

### B.3 连接之后

- 隧道落在**本机随机回环端口**（不是固定 4096），确认对话框后**新开一个窗口**指向 `http://127.0.0.1:<port>`；本地窗口保持不动，标题栏显示 `<主机名> — …`。
- 隧道意外断开会自动重连，最多 3 次；手动 **Disconnect** 只关闭隧道与远端窗口会话，不重连。
- 远端 server 的模型凭据独立于本机（见 E.4），首次连接后需要在远端窗口的 Customize 里配置，或把本机 `<data>/auth.json` 拷过去。

底层语义与 A 节完全一致：远端 server 只监听远端回环，SSH 隧道是唯一通道。

---

## C. 运行时模式与本地扩展同步（本轮新增）

B 节的连接管理器在第二轮的行为是"确认后新开一个独立远程窗口"。现在 SSH 区块的每条连接提供两种用法，并且连接时会把本地扩展状态镜像到远端：

### C.1 运行时模式：主窗口直接跑在远程 server 上

- **Connect（运行时模式）**：成功后不弹确认、不开新窗口，而是把**主窗口背后的 server** 切到该连接的隧道地址——数据、会话、终端、命令全部落在远端 server 上，本地 sidecar 继续跑着但不再被使用。实现上：对话框以 `purpose: "runtime"` 调用桥（`frontend/workspace/src/components/dialog-select-server.tsx:316-337`），主进程走 `runtimeTunnelUp`——隧道健康检查通过后记住选择并广播切换（`frontend/desktop/src/main.mjs:1159-1172`、`main.mjs:1244-1252`）；本地所有窗口经 `openscience:server:use` 事件收到新地址（`main.mjs:1111-1118`，只发给本地窗口；远程工作区窗口没有 preload，不接触 SSH 设施），工作区订阅后切换活跃 server（`frontend/workspace/src/context/server.tsx:284-291`）。对话框弹成功 toast「Switched to remote runtime」，该条目出现 **Runtime** 徽标（`dialog-select-server.tsx:437-439`）。
- **Window（旧独立窗口行为）**：保留第二轮的流程——确认框 → 新开一个隔离的远程工作区窗口，本地主窗口保持不动（`dialog-select-server.tsx:339-356`）。两种模式共用同一次 connect（部署 + 同步 + 隧道），差别只在隧道建好之后主进程做什么。
- **选择会持久化**：当前 runtime 连接 id 存在连接存储的 `runtime` 字段，跨应用重启保留；`setRuntime` 只接受当前列表里存在的 id（`frontend/desktop/src/ssh-connections.mjs:1232-1239`、持久化在 `ssh-connections.mjs:579-598`）。
- **断开 / 移除回落本地**：对当前 runtime 连接点 **Disconnect** 或 **Remove**，主窗口立即回落到本地 sidecar（`main.mjs:1212-1231`）。运行时隧道自动重连的 3 次重试耗尽、或该连接自己的 connect 失败（`failed` 事件），同样自动回落本地；回落只在"仍是当前选择"时执行，不会覆盖期间新选的 runtime（`main.mjs:1078-1090`）。
- **应用重启自动恢复**：首个窗口创建完成后，主进程在后台恢复上一会话选中的 runtime 连接（`main.mjs:1386`、`restoreRuntime` 在 `main.mjs:1178-1197`）——启动不等待 SSH：部署/上传可能耗时数分钟，隧道在后台拉起，工作区经 `openscience:server:use` 获知切换。恢复期间如果你重新选择了别的 runtime，较新的选择胜出，迟到的旧隧道会被拆除；恢复失败（例如记录已被删）只清除失效的选择，并向 stderr 写一行说明，工作区留在本地。
- **CSP 放宽**：本地 sidecar 页面的 `connect-src 'self'` 在页面加载时已固定，而运行时切换发生在页面挂载之后，因此主进程在首个窗口加载前注册 `onHeadersReceived`，把**本机回环页面**的 connect-src 扩为 `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*`（`main.mjs:1131-1149`，注册于 `main.mjs:1339-1341`）。只放宽 connect-src、只覆盖 http/ws 回环来源；远程工作区窗口在各自的 `persist:workspace-*` 分区里保持同源策略不变。

### C.2 本地扩展同步（连接时自动执行）

- **时机**：connect 流程固定为 探活 → 部署/升级 sidecar（必要时启动或重启远端 server）→ **扩展同步** → 开隧道（`frontend/desktop/src/ssh-connections.mjs:1144-1165`）。同步发生在部署**之后**、开隧道之前；若 deploy 刚启动/重启了远端 server，同步发生在这次启动之后——`frontend/desktop/src/remote-sync.mjs:16-19` 的实现注释因此提示：同步进远端 data 的文件在**下一次远端 server 启动**时才被读到。各文件实际读取时机不同（例如 auth.json 每次请求都重读，`backend/cli/src/util/jsonstore.ts:36-40`），改动凭据后如需确保立即生效，可再次连接或重启远端 server（`ssh <host> 'kill "$(cat ~/.openscience/remote/server.pid)"'` 后重连）。
- **同步清单**（`frontend/desktop/src/remote-sync.mjs:50-76`，按此顺序逐项执行；本地不存在的项直接跳过，不会删除或清空远端对应内容）：
  - `.openscience/user-skills` → 远端 `~/.openscience/remote/data/user-skills`（**合并**：远端独有的 skill 保留，同步项只覆盖自己的文件）；
  - `.openscience/installed-skills` → 远端 `~/.openscience/remote/data/installed-skills`（**合并**）；
  - `~/.claude/skills` → 远端 `~/.claude/skills`（**合并**）；
  - `~/.config/openscience` → 远端 `~/.openscience/remote/config`（**整体替换**：这是远端 server 的 `XDG_CONFIG_HOME`，后端在其下解析 `openscience` 配置目录，`backend/cli/src/global/index.ts:29-43`。替换走旁路 staging——先把新目录完整解包到 `<remote>.sync-staging`，全部到位后才 `rm -rf` 旧目录并 `mv` 进位，传输中断不会破坏远端正在使用的配置根，失败时清理 staging 并如实报错；`frontend/desktop/src/ssh-connections.mjs:734-766`）；
  - 数据根单文件一一复制：`auth.json` / `credentials.json` / `credentials.key` / `mcp-auth.json` / `compute.key` / `settings-compute.json` → 远端 `~/.openscience/remote/data/`。
- **机制**：每项在本地用 `tar` 打包（argv 数组、硬超时、stderr 有界，`ssh-connections.mjs:690-717`），经 ssh stdin 流到远端 `tar -xf -` 解包；所有远端路径经 `remoteHomePath()` 锚定在**远端 `$HOME`**（`ssh-connections.mjs:63-65`），命令行里不出现本地 home 的绝对拼写，两端用户名/家目录不同也正确。
- **软失败**：任一项失败即停止剩余项，connect 发出 `Local extension sync skipped: <原因>` 的 `syncing` 事件后**照常继续到隧道**——同步是便利而非前置条件（`ssh-connections.mjs:1148-1165`；软失败语义测试 `frontend/desktop/test/ssh-connections.test.mjs:975-1004`）。失败时远端已有状态保持原样：合并项不动，替换项保留旧配置根且不留 staging 残留（`ssh-connections.test.mjs:928-959`）。

### C.3 限制与安全

- **secrets 会随同步落到远程主机**：`auth.json`、`credentials.json` / `credentials.key`、`mcp-auth.json`、`compute.key` 等凭据会以远端 SSH 用户身份写入远端家目录下的数据根。这**不新增威胁边界**：服务端本来就只监听远端回环，"能 SSH 登录该主机的人才能控制这个 server"是既有边界（见 E.3）；同步只是把这些人本来就能在远端 Customize 里手工配置的东西自动化了。若远端是多用户共享主机，请把该主机视同保存了你的模型凭据来对待。
- **MCP stdio 连接器的命令需要在远程存在**：`type: "local"` 的 MCP 连接器由 server 进程在**自己所在的主机**上启动 `mcp.command`（`backend/cli/src/mcp/index.ts:932-970`）。server 迁到远端后，`npx` / `uvx` / 解释器等命令必须在该远端主机上可用且版本兼容，否则对应连接器启动失败并在 UI 报 failed——本机能跑不等于远端能跑。
- **npm 插件的远程自动安装不依赖系统 `bun`，但依赖 npm registry 可达**：`config.plugin` 里的 npm 包由 `BunProc.install` 安装，它 spawn 的是 server 自身的可执行文件（`process.execPath`，即部署的 sidecar）加 `BUN_BE_BUN=1` 充当 bun CLI（`backend/cli/src/bun/index.ts:21-31`、`backend/cli/src/bun/index.ts:84-102`），不调用系统 `bun`。真正的限制是：远端主机必须能访问 npm registry——不可达时安装按 30 秒超时失败（`OPENSCIENCE_PLUGIN_INSTALL_TIMEOUT_MS` 可调，`backend/cli/src/plugin/index.ts:36-58`），对应插件不可用。
- **同步只发生在 connect 时**：连接期间本地对 skills / 配置 / 凭据的改动不会实时推送到远端，需要再次连接（Disconnect → Connect，或重连）才会重新镜像。

### C.4 常见问题

- **同步失败怎么知道？哪里看消息？** 失败不弹窗、不阻断连接，只经 SSH 事件总线发出一条 `Local extension sync skipped: <原因>`（`ssh-connections.mjs:1160-1164`）。现状说明：当前界面把事件只映射为 Servers 对话框里该条目的状态点（`dialog-select-server.tsx:194-198`、`dialog-select-server.tsx:259-263`），**这条消息文本没有任何专门的展示位**。要确认是否同步成功，直接比对本地与远端对应路径（例如 `ssh <host> 'ls ~/.openscience/remote/data ~/.openscience/remote/config'`）即可；替换项失败时远端配置根保持原样，不存在半套配置。
- **能只同步一次，或把同步关掉吗？** 现状：不能。同步无条件跟随**每一次** Connect（运行时与窗口模式共用同一 connect 流程，`ssh-connections.mjs:1147-1165`），没有配置开关，也没有"只同步一次"的按钮。唯一间接手段是让本地不存在对应路径——`remote-sync.mjs:75` 的 existsSync 过滤会把本地缺失的项直接从清单里去掉（例如把 `auth.json` 移走就不会再覆盖远端的），或者干脆不点 Connect。
- **怎么切回本地 server？** 在 Servers 对话框对当前 Runtime 连接点 **Disconnect**，主窗口立即回落本地 sidecar（`main.mjs:1224-1231`）；下次连接再点 Connect 即可回到远程运行时。

---

## D. Docker（本地 / 远程 GPU 主机）

### D.1 构建镜像

```bash
bash docker/build-runtime.sh
```

脚本会检查 `backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience`（缺失时给出重建指引：`bun run --cwd backend/cli build`），把二进制暂存进临时 `sidecar/` 构建上下文（构建后自动清理），产出镜像 `openscience-runtime:local`。镜像内非 root 用户 `openscience`（uid/gid 1000）运行，数据目录 `/data`（`ENV OPENSCIENCE_DATA_DIR=/data`），见 `docker/Dockerfile.runtime`。

### D.2 为什么必须 `--network host`

服务端在容器里同样只绑定容器自身的 `127.0.0.1`。Docker 的端口发布（`-p`）把流量转给**容器的 eth0**，而服务只监听容器回环，永远不通。本机实测（Docker 26.1.5）：

```
docker run -p 127.0.0.1:18096:18096 ... python3 -m http.server 18096 --bind 127.0.0.1
curl http://127.0.0.1:18096/    # curl: (56) Recv failure: 连接被对方重置
docker run --network host ... python3 -m http.server 18097 --bind 127.0.0.1
curl http://127.0.0.1:18097/    # HTTP 200
```

所以运行镜像要用 `--network host`（Linux 宿主）：容器与宿主共享网络命名空间，容器内的 `127.0.0.1:4096` 就是宿主的 `127.0.0.1:4096`，"仅回环可访问"的安全边界不变。若未来 server 增加绑定地址选项，才可以用 `-p` 写法。

### D.3 运行

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

## E. 安全注意

1. **服务端固定 `127.0.0.1`**：没有任何 flag / 环境变量能改绑定地址（`backend/cli/src/cli/network.ts:24-27`），不存在"误听公网"的配置路径。
2. **不要公网直连**：不要在远程主机防火墙开放 4096，也不要把它挂在反代/公网 IP 上。服务没有为公网暴露设计的鉴权层，公网可回环 = 任何人可控制你的会话。
3. **隧道是默认安全边界**：谁能 ssh 到远程主机，谁才能用这个服务。`-L 4096:127.0.0.1:4096` 只转发远端回环，宿主外部接口上的流量到不了服务。
4. **远程主机需自配模型 key**：凭据存在服务端数据目录的 `auth.json`（`backend/cli/src/auth/index.ts:56`），远程 server 不会复用你本机的 key。Manager 部署的 server 数据目录固定为 `~/.openscience/remote/data`，连接远端 server 后在 Customize 的 Provider keys / 凭据页配置，或把本机 `<data>/auth.json` 拷贝到远端 `~/.openscience/remote/data/auth.json`。模型请求由远端 server 发出，走的也是远端的网络。
5. **权限模式同样生效**：项目级 `Ask always / Ask risky / Full access`（`ProjectAccess`，CHANGES.md 任务 3）在远程会话中一致；`Full access` 会跳过日常工具确认，切换时保留一次确认对话框，且显式 `deny` 规则与付费远程计算的预算审批仍会询问。

---

## F. 断网语义、权限等待与 server 重启

- **断网**：桌面每 10 秒探测 server 健康（`dialog-select-server.tsx:330-335`），确认不可达后显示"Can't reach your local OpenScience server"横幅（`frontend/workspace/src/atlas/DisconnectedPanel.tsx:8-13`），恢复后自动消失。会话与项目数据都在服务端数据目录，客户端只是视图——隧道断开不丢数据，但断线期间发出的消息不会自动补发，恢复后重试或新开会话。
- **权限等待**：被询问的权限由服务端持有，`ask` / `approve` 模式下工具调用会停下等待批准；页面关闭、重连不影响服务端等待状态，审批结果持久化在数据目录。`full` 模式跳过日常确认（边界见 E.5）。
- **server 重启**：SIGTERM 触发优雅停机，服务管理器场景最长 12 秒（`backend/cli/src/cli/server-stop.ts:10`），desktop sidecar 场景 4 秒（`server-stop.ts:18`）。重启后会话、项目、凭据均在 `/data` / `OPENSCIENCE_DATA_DIR` 中；桌面健康探测会自动重连；进行中的终端/WebSocket 连接会提示中断（对应 i18n "terminal connection was interrupted…"）。systemd unit 配了 `Restart=on-failure` 即自动拉起。

---

## G. 常见问题排查

**G.1 隧道断开** — 横幅出现 + Servers 列表红点。先确认本机 ssh 进程还在、远端 serve 还活着（`ssh gpu-host 'curl -s http://127.0.0.1:4096/global/health'`）。长期稳定建议：`ServerAliveInterval 30` + `ServerAliveCountMax 3` 保活、`ExitOnForwardFailure=yes`，或用 autossh / systemd --user 单元管理隧道。注意本机 4096 若被你自己的本地 server 占用，换 `-L 4097:127.0.0.1:4096` 并在 Servers 里加 `http://127.0.0.1:4097`。

**G.2 远程磁盘** — 数据目录会随会话、工具产物、日志增长，先 `du -sh ~/openscience-data` 定位；磁盘满时 server 写入会失败、会话保存异常。迁移位置即改 `OPENSCIENCE_DATA_DIR`（显式覆盖优先于指针文件，`backend/cli/src/global/index.ts:61-78`），Docker 场景换掉 `-v` 挂载即可。

**G.3 版本升级** — 重新构建 sidecar（`bun run --cwd backend/cli build`）后：二进制部署直接替换并重启服务；Docker 场景重跑 `bash docker/build-runtime.sh` 并在远端重新 `docker run`（或 `docker save | ssh gpu-host 'docker load'`）。桌面 Servers 对话框会在条目上显示 server 版本徽章（`dialog-select-server.tsx:627-634`），也可对照 `curl http://127.0.0.1:4096/global/health` 里的 `version` 字段。远端与桌面差异过大时建议两端一起升。

**G.4 4096 被占用** — 显式传了 `--port` 时端口不可用会直接启动失败（`backend/cli/src/server/server.ts:929-930`），看服务日志报错即可；换端口后，桌面 Servers 里的 URL 同步改。

**G.5 健康检查** — 任何一步卡住先跑 `curl http://127.0.0.1:4096/global/health`：在**远端本机**跑验证服务侧，在**本地**跑验证隧道侧，两边对照即可定位问题在哪一段（本文档撰写时已在本地实测：返回 `{"healthy":true,"version":"2.0.153-local.1",...}`）。
