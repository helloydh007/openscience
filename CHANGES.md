# OpenScience 本地优先改造记录

本仓库是 [`synthetic-sciences/OpenScience`](https://github.com/synthetic-sciences/OpenScience) 的 fork：

- Fork 地址：<https://github.com/helloydh007/openscience>
- 上游基线：`a08e0ad release: v2.0.153`（分支历史完整保留，改动为两个快进提交）
- 本次提交：
  - `66d63f0 feat: local-first OpenScience (privacy, BYOK models, permissions)`
  - `ad2cd29 build: reproducible Ubuntu 22.04 Wayland AppImage`
- 目标：移除隐藏上传与账号体系，完善 BYOK 模型配置，增加会话级权限按钮，并产出 Wayland 原生可用的 AppImage。

## 打包形态选型

**结论：复用项目自带的 Electron 外壳（`frontend/desktop`）+ 原生 CLI sidecar，而不是 Tauri 或纯浏览器方案。**

理由：

1. 上游本身已提供 Electron 壳：它启动 `openscience serve --print-logs` 的本地 sidecar，再加载同一套 SolidJS 工作区，原生窗口、文件选择、日志和更新骨架都已存在。
2. 项目后端是 Bun 编译出的单文件原生二进制（`backend/cli/script/build.ts`），Electron 壳只是它的窗口层，改造量最小、回归风险最低。
3. Tauri 需要另写 Rust 壳并重新解决 sidecar 进程管理、单实例、文件对话框、Wayland 缩放等问题，收益仅是体积更小，与本任务目标无关。
4. AppImage 由 `electron-builder` 生成；在 Ubuntu 22.04 容器中构建可把 glibc 目标压到 2.35，向后兼容性优于在 Debian 13 宿主直接构建。

---

## 任务 1：移除隐藏数据上传

### 审计结论

上游唯一的“隐藏上传”是 **登录后默认开启的会话轨迹上传**（`session/usage-logging.ts`）：它把 prompt、模型输出、工具入参/结果、token 用量压缩后 POST 到 `https://app.syntheticsciences.ai/api/v1/telemetry/batches`，上传前先请求 `/api/v1/telemetry/consent`。此外还有账户凭证同步、托管账单回执、日志健康检查三个附属外呼。

### 已移除 / 已禁用

| 位置                                                                                     | 原行为                                                          | 处理                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/cli/src/session/usage-logging.ts`                                               | 队列 + 远程 consent + 批量上传完整轨迹                          | 重写为纯本地观测模块：`context()` 永远返回 `undefined`，`bind/part/record/event` 全部 no-op，上传实现整体删除；保留 `reported()` 供本地 usage 统计 |
| `backend/cli/src/index.ts`                                                               | 每次 CLI 启动 `UsageLogging.start()`、退出时 `drain()`          | 调用删除                                                                                                                                           |
| `backend/cli/src/index.ts`                                                               | 启动 `OpenScience.startCredentialSync()`（每 90s 同步账户凭证） | 调用删除                                                                                                                                           |
| `backend/cli/src/server/routes/settings/usage-logging.ts`                                | `/settings/usage-logging`、`/health` 路由                       | 文件与挂载删除                                                                                                                                     |
| `backend/cli/src/session/logging-health.ts`                                              | `GET /api/v1/telemetry/health` 上报 installation_id             | 文件删除（已无调用方）                                                                                                                             |
| `backend/cli/src/session/task-receipts.ts`                                               | `POST /api/credits/call-receipts` 上传 call id 列表             | 远程请求与存储逻辑删除，只保留本地 audit，固定返回 `signed_out`                                                                                    |
| `frontend/workspace/src/components/settings/UsageLogging.tsx`、`ServerLoggingHealth.tsx` | 轨迹共享开关与“检查服务器”                                      | 组件删除，Permissions 面板中的挂载删除                                                                                                             |
| `frontend/workspace/src/context/settings.tsx`                                            | 启动时自动检查上游更新                                          | 默认改为 `false`（仍可在 General 手动检查；检查只读取版本元数据，不上传用户数据）                                                                  |

### 保留（均为用户主动触发，且不包含“隐藏上传”）

- 模型 API 请求：只发往用户配置的 provider / base URL。
- 科学数据库（UniProt、PDB、NCBI、ChEMBL 等）：Agent 调用科研工具时的显式查询。
- `models.dev` 目录读取：静态 GET，不含用户数据；构建时改为使用仓库内快照（见任务 5）。
- GitHub / npm 版本检查：仅手动或显式升级时发生。

### 验证

```bash
# 源码与二进制中都不再出现上传端点
grep -rn "telemetry/consent\|telemetry/batches\|call-receipts" backend/cli/src frontend/workspace/src
strings backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience | grep -E "api/v1/telemetry|call-receipts"
# 两条命令均应无输出
```

本地启动后 `GET /settings/usage-logging`、`GET /account` 均返回 404 JSON（不再是可用路由）。

---

## 任务 2：OpenCode Go、自定义模型与连接验证

### OpenCode Go

模型目录快照本身已包含 `opencode-go`（`api=https://opencode.ai/zen/go/v1`、`npm=@ai-sdk/openai-compatible`、`env=OPENCODE_API_KEY`）。本次把它做成一等入口：

- `frontend/workspace/src/components/settings/model-providers.ts`
  - 新增预设 `opencode-go`，Base URL 自动填 `https://opencode.ai/zen/go/v1`。
  - 新增 `custom` 预设（自定义 OpenAI-compatible）。
- `backend/cli/src/provider/key-check.ts`
  - 新增 `opencode-go` 探测：`GET /models` + `Authorization: Bearer`。
  - `repointed()` 允许“配置的 Base URL 恰好等于官方地址”时仍执行探测；只有真正改到自定义地址才跳过。
- `backend/cli/src/cli/onboard.ts`、`cli/cmd/models.ts`
  - 终端初始化与模型列表加入 OpenCode Go。
- `frontend/workspace/src/context/model-catalog.ts`
  - `isFrontier()` 对 `opencode-go` 返回 true，所有该 provider 的模型默认出现在选择器，无需先去 Manage Models 打开。

### 自定义模型

新增后端路由 `backend/cli/src/server/routes/settings/custom-model.ts`，挂载于 `/settings/custom-model`：

- `POST /`：保存自定义模型。
  - 入参：`providerID`、`baseURL`、`modelID`、可选 `modelName/contextLimit/outputLimit/apiKey`。
  - 写入 `Config.setProvider`（`npm=@ai-sdk/openai-compatible`、`api/options.baseURL`、`models[modelID]`）；有 API key 时写入本地 `auth.json`。
  - 无 key 的本地/内网 endpoint 也允许保存（`requiresCredential=false`）。
  - 失败时回滚 provider 配置与凭据。
- `POST /verify`：只向用户填写的 `baseURL` 发一次请求。
  - 先 `GET {baseURL}/models`，检查 `modelID` 是否在返回列表中。
  - 若服务端不支持 `/models` 且有 `modelID`，回退到 `POST {baseURL}/chat/completions`（`max_tokens: 1`）。
  - 返回 `{ok, status, modelFound, models, error}`；401/403 明确提示认证被拒绝，超时/无响应明确提示不可达。
  - 不做任何硬编码中转、重定向或第三方回退。

前端 `ProviderKeys.tsx`：

- 表单新增 `Model ID`、`Display name`、`Provider ID`（自定义 provider 时显示，留空则从 URL host 派生）。
- 新增 **Test connection** 按钮，展示成功/失败、HTTP 状态或模型未找到的说明。
- 保存自定义模型后立即刷新 provider 列表，模型出现在模型选择器。
- 已连接 provider 列表不再只显示内置 16 家，自定义 provider 也会显示。

### 交互说明

1. Customize → Models → Add（Provider keys）。
2. 选择 `OpenCode Go`，填入 `OPENCODE_API_KEY`；Base URL 已预填且可改。
3. 若模型不在目录中，填 `Model ID`（如 `deepseek-v4.1-flash`）与可选显示名。
4. 点 **Test connection**：绿色为 `Connected · model "…" is available`；失败显示 HTTP 状态与摘要。
5. Save 后回到模型选择器即可看到该模型。

---

## 任务 3：会话界面的权限按钮

### 前端

`frontend/workspace/src/components/prompt-input.tsx`

- 在输入框底部工具栏（Working folder 旁边）新增常驻权限 chip：
  - 显示当前模式：`Ask always` / `Ask risky` / `Full access`。
  - 点击展开三档菜单，选项与设置页一致；选择后调用既有 `PUT /project/:projectID/access`。
  - `Full access` 有独立警示色，选中时菜单内显示红色提示：
    > Full access runs tools, shell commands and file edits without asking. Only enable it for projects you trust.
  - 切换为 Full access 仍会弹出一次确认对话框（上游既有行为），避免误触。
- 样式：`frontend/workspace/src/components/working-folder.css`（复用 composer chip 的布局）。
- 选择持久化：沿用上游 `ProjectAccess`（`<data>/storage/project_access/<projectID>/<rootHash>.json`），刷新页面、切换会话后保持。

### 后端联动

无需新增权限枚举。上游 `ProjectAccess.Mode = "ask" | "approve" | "full"` 已经贯通：

- `permission/next.ts:modeAction()` 在 `full` 下对 `bash` 返回配置值、强制 `environment_mutation=allow`；`agent/agent.ts` 为 full 模式构建 allow-all 规则集，`project/access.ts` 同时关闭 sandbox。
- chip 写入的 `mode` 就是这套规则读取的值，因此“完全访问”会真正跳过工具确认，而不是只改 UI。
- 仍保留的边界：显式 `deny` 规则、未知权限类型、付费远程计算（Modal/远程集群）的预算审批仍会询问；这是有意的安全边界。

### 交付说明

- 该按钮位于对话框输入区，默认 `Ask risky`。
- 切到 `Full access` 后，Agent 执行 shell、编辑、MCP、网络等日常工具不再逐次询问。

---

## 任务 4：移除内置登录（Synthetic Sciences + ACE）

### 后端

| 位置                                                             | 处理                                                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `backend/cli/src/cli/cmd/connect.ts`                             | 删除（`login/logout/status/devices/sync` 命令实现）                                                                                 |
| `backend/cli/src/cli/cmd/billing.ts`                             | 删除（Wallet 命令）                                                                                                                 |
| `backend/cli/src/index.ts`                                       | 移除上述命令注册；启动不再触发凭证同步                                                                                              |
| `backend/cli/src/cli/onboard.ts`                                 | 重写为纯 BYOK：不再要求账号、不再引导 Ace；`shouldRun()` 返回 false，首次启动直接进入工作区；`openscience init` 仍可做可选 key 配置 |
| `backend/cli/src/server/routes/account.ts`                       | 删除（浏览器登录、粘贴 key、session、设备管理）                                                                                     |
| `backend/cli/src/server/routes/onboarding-auth.ts`               | 删除                                                                                                                                |
| `backend/cli/src/server/routes/settings/billing.ts`、`wallet.ts` | 删除                                                                                                                                |
| `backend/cli/src/server/server.ts`                               | 上述路由挂载与 import 删除；新增 custom-model 路由                                                                                  |
| `backend/cli/src/openscience/index.ts`                           | `getSession()` 直接返回 `null`，旧安装残留的 `openscience-session.json` 也被忽略；默认计费模式改为 `byok`                           |
| `backend/cli/src/auth/index.ts`、`settings/credentials.ts`       | 与账号同步相关的错误文案改为本地化表述；Atlas 密钥仍被拒绝写入 provider key                                                         |

### 前端

| 位置                                                                                              | 处理                                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `frontend/workspace/src/atlas/DesktopOnboarding.tsx`（及测试）                                    | 删除，`app.tsx` 不再用它包裹路由；桌面启动直接进入工作区                      |
| `frontend/workspace/src/components/settings/Ace.tsx`、`ManagedInference.tsx`、`LoginApproval.tsx` | 删除                                                                          |
| `frontend/workspace/src/components/settings/registry.ts`                                          | 移除 `ace` 面板                                                               |
| `frontend/workspace/src/components/dialog-settings.tsx`                                           | 侧栏底部不再请求 `/account`，改为 “Local-first · bring your own key” + 版本号 |
| `CredentialServices.tsx`                                                                          | 移除跳转 `app.syntheticsciences.ai` 的 “Manage” 链接                          |
| `Usage.tsx`、`task-receipts.tsx`、`model-settings-popover.tsx`                                    | 移除 “登录 Ace / Synthetic Sciences” 引导文案                                 |
| `context/settings.tsx`                                                                            | 启动更新检查默认关闭                                                          |

### 降级表现

- 首次启动：不再出现任何登录页或向导，直接进入 Projects / Workspace。
- 无模型时：模型选择器提示 “Add a provider key … under Manage models”，不会再引导登录。
- Atlas/Ace 托管模型：不出现（`getSession()` 恒为 null，managed provider 不会构建）。
- Wallet、设备管理、云端凭证同步、托管账单：入口和路由均不存在；旧数据文件不会被读取。
- 科研工具中依赖 Ace 的托管搜索/图像路由在没有自有 key 时会返回明确的“需要配置”错误，不会崩溃或循环重试。

---

## 任务 5：Wayland AppImage

### 构建

```bash
./docker/build.sh
# 产物：dist/OpenScience-linux-x64.AppImage
```

`docker/build.sh` 做的事：

1. 以本机已有的 `nvidia/cuda:12.4.1-base-ubuntu22.04`（Ubuntu 22.04 / glibc 2.35）构建镜像。
2. 镜像内安装 Node 24.21.0、Bun 1.3.14、electron-builder 依赖。
3. 使用仓库自带 `backend/cli/test/fixture/models-catalog.json.gz` 作为 `MODELS_DEV_API_JSON`，离线生成模型快照（含 `opencode-go`）。
4. `bun install` → `bun run --cwd backend/cli build --skip-install --target=linux-x64`（Vite 构建工作区 UI 并嵌入 Bun 单文件二进制）。
5. `OPENSCIENCE_DESKTOP_SIDECAR=… bun run --cwd frontend/desktop dist -- --linux --x64` 生成 AppImage。

### Wayland 处理

- `frontend/desktop/src/main.mjs` 在 app ready 前设置：
  ```js
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations,WaylandFractionalScaleV1,EnableWaylandIme",
  )
  app.commandLine.appendSwitch("ozone-platform-hint", "auto")
  ```
  `auto` 在 Wayland 会话使用原生 Wayland；X11 会话自动回退，不破坏原有行为。
- `frontend/desktop/electron-builder.mjs`
  - `linux.executableArgs` 重复上述 flags，保证桌面启动器直接拉起时也生效。
  - `afterPack` 删除打包目录内任何 `libwayland*`，避免把构建宿主的 Wayland 客户端库带进 AppImage 与宿主 Mesa 冲突。
- AppImage 不打包 `libwayland-client`，运行时使用系统库。

### 兼容性

- 构建容器 glibc 2.35；sidecar 与 AppImage 均在该环境编译。
- 未启用 Electron 自更新：Linux 上上游 updater 只支持 macOS，且本 fork 不应被上游包覆盖。

---

## 改动文件汇总

见 `git show --stat` / 本文各节。主要新增：

- `backend/cli/src/server/routes/settings/custom-model.ts`
- `docker/Dockerfile`、`docker/build.sh`、`docker/build-appimage.sh`
- `.dockerignore`、`CHANGES.md`

主要删除：

- 账号/ACE 登录：`cli/cmd/connect.ts`、`cli/cmd/billing.ts`、`server/routes/account.ts`、`server/routes/onboarding-auth.ts`、`settings/billing.ts`、`settings/wallet.ts`、`atlas/DesktopOnboarding.tsx`、`settings/Ace.tsx`、`settings/ManagedInference.tsx`、`settings/LoginApproval.tsx`
- 遥测：`server/routes/settings/usage-logging.ts`、`session/logging-health.ts`、`settings/UsageLogging.tsx`、`settings/ServerLoggingHealth.tsx`
- 对应测试（删除模块的测试）

## 验证记录

### 类型检查

```text
bun run --cwd backend/cli typecheck            # tsgo --noEmit, exit 0
bun run --cwd frontend/workspace typecheck      # tsgo -b, exit 0
```

### 隐藏上传

```text
grep -rn "telemetry/consent|telemetry/batches|call-receipts" backend/cli/src frontend/workspace/src
# 无输出
strings .../bin/openscience | grep -E "api/v1/telemetry|call-receipts"
# 无输出
```

### 模型验证按钮（真实本地 mock endpoint）

```text
POST /settings/custom-model/verify {"baseURL":"http://127.0.0.1:4610/v1","apiKey":"test-key","modelID":"demo-model"}
→ {"ok":true,"status":200,"modelFound":true,"models":["demo-model","second-model"]}

POST ... {"apiKey":"wrong",...}
→ {"ok":false,"status":401,"error":"Authentication was rejected: ..."}

POST ... {"modelID":"nope"}
→ {"ok":false,"status":200,"modelFound":false,"error":"The endpoint lists 2 models, but not \"nope\"."}

POST /settings/custom-model {"providerID":"custom-demo",...}
→ true；GET /provider 显示 connected ["custom-demo"]，models.demo-model 可调用。
```

### OpenCode Go

```text
PUT /auth/opencode-go/connection {"key":"...","baseURL":"https://opencode.ai/zen/go/v1"}
GET /provider → connected 包含 opencode-go，模型 16 个（目录 22 个，其余被上游状态过滤）
```

界面截图 `docs/local-first/models-opencode-go.png`：Provider=OpenCode Go、Base URL 预填、Model ID/Display name/Test connection 均可见。

### 权限按钮与后端联动

```text
PUT /project/<id>/access {"mode":"full","root":"/tmp/os-app/demo"}
→ mode:"full", source:"persisted", sandbox.enabled:false, revision:2
```

截图 `docs/local-first/permission-chip.png`、`permission-menu.png`：输入框下方常驻 `Full access` chip，菜单三档与红色警示；写入的正是上述 `ProjectAccess`，full 模式在 `modeAction`/`agent.ts` 中跳过日常工具确认并关闭 sandbox。

### 登录移除

- 首次启动直接是 Projects 页面：`docs/local-first/projects-no-login.png`。
- 设置侧栏无 Ace 面板，底部为 “Local-first · bring your own key”：`docs/local-first/models-opencode-go.png`。
- 已删除路由返回 JSON 404：
  ```text
  GET /account                → {"error":"not_found","path":"/account"}
  GET /settings/usage-logging → 404 JSON
  GET /settings/billing       → 404 JSON
  ```

### Wayland

AppImage 在 KDE Plasma Wayland（`XDG_SESSION_TYPE=wayland`，`WAYLAND_DISPLAY=wayland-0`）中启动：

```text
openscience --enable-logging=stderr
→ ui/ozone/platform/wayland/...                # Ozone Wayland 后端
→ /proc/<pid>/maps 含 libwayland-client.so.0.23.1 / libwayland-egl.so.1.23.1
→ 子进程 resources/sidecar/openscience serve --port 40803
→ GET /global/health {"healthy":true,"version":"2.0.153-local.1"}
```

完整日志：`docs/local-first/wayland-launch.log`。

### 最终 AppImage

- 构建：`./docker/build.sh`（Ubuntu 22.04 / glibc 2.35）
- 产物：`dist/OpenScience-linux-x64.AppImage`（186 MB）
- SHA-256：`e0301247b93e725797ccedbb4dec4b71a96ab8ef36a6aeb859d18c9746801dd2`
  （见 `docs/local-first/appimage.sha256`；此版本含 OpenCode Go 会话头修复）
- sidecar 的 ELF 最高只引用到 `GLIBC_2.17`，可在老发行版加载；Electron 自身按 v44 的系统要求运行
- desktop Exec 带 `--enable-features=UseOzonePlatform,WaylandWindowDecorations,... --ozone-platform-hint=auto`
- `afterPack` 后包内无 `libwayland*`（使用系统库）
- 最终包在 KDE Plasma Wayland 中启动、sidecar health 正常、页面无登录：
  `docs/local-first/projects-final-wayland.png`、`wayland-final.log`

## 修复：OpenCode Go 返回 400 MissingSessionID

**现象**：调用 OpenCode Go 模型返回
`Request is missing x-opencode-session and cannot be routed efficiently` / HTTP 400。

**原因**：OpenCode Go 要求每个对话请求带稳定的 `x-opencode-session: ses_…`（用于路由与 prompt cache），OpenScience 只发送了 `User-Agent`。

**修改**：

- `backend/cli/src/session/llm.ts`：对 `opencode-go` 的每次 `streamText` 注入
  `"x-opencode-session": input.sessionID`。OpenScience 的会话 ID 本身就是 `ses_…`，
  且在整个对话（含重试）中稳定。
- `backend/cli/src/server/routes/settings/custom-model.ts`：Test connection 对带 key 的
  请求先执行一次 `max_tokens: 1` 的 chat completion 探测；`GET /models` 在 OpenCode
  是公开的，不能用来判断 key 是否有效。未填写 Model ID 的 OpenCode Go 取模型列表
  第一项探测。
- `frontend/workspace/src/components/settings/ProviderKeys.tsx`：验证请求带上 provider id。

**复测**：

```text
POST /zen/go/v1/chat/completions（无 session 头，假 key）→ 400 MissingSessionID
POST /zen/go/v1/chat/completions（x-opencode-session: ses_test123，假 key）→ 401 Invalid credential
```

即网关已接受会话头，剩余错误只与真实 API key 有关。

最终 AppImage 的端到端复测（OpenCode Go provider 指向本地 SSE mock）：

```text
POST /v1/chat/completions
x-opencode-session: ses_e42178ffcffeHxNgiApvXNU8tE   ← 与实际会话 ID 一致
user-agent: openscience/2.0.153-local.1 ai-sdk/provider-utils/... runtime/bun/1.3.14
authorization: Bearer test-key
→ 对话正常完成（finish: stop）
```

---

# 第二轮改造：远程运行时与性能（2026-11-11）

基于第一轮的调研结论实施（不基于 OpenCode v2）。六个工作流任务并行完成，经类型检查、测试门禁与独立评审复核。

## 性能修复

### 1. GET /provider 响应瘦身（`backend/cli/src/server/routes/provider.ts`）

目录型（未连接）provider 不再逐个构建完整 models 目录，改为轻量 stub `{ id, source: "custom", name, env, options: {}, models: {} }`；connected provider 照旧完整构建并覆盖合并；`default` 只为 models 非空的 provider 计算（同时修掉了空数组取 `[0].id` 的潜在崩溃）。抽出纯函数 `slimProviderResponse` 并新增测试 `test/server/provider-list-slim.test.ts`。

实测（相同内置目录、全新缓存）：

| 指标     | 改造前     | 改造后      |
| -------- | ---------- | ----------- |
| 首次请求 | 2.5–3.4 s  | **0.32 s**  |
| 热请求   | 2.9–8 s    | **5–9 ms**  |
| 响应体   | 4.1–6.5 MB | **19.5 KB** |

### 2. Provider 状态懒构建（`backend/cli/src/provider/provider.ts`）

`_loadState` 不再为目录里全部 provider（5760–8932 个 model）预构建完整对象，改为 stub + 按需物化：仅候选 provider（config、auth、env-key、CUSTOM_LOADERS、openai-codex、openrouter、github-copilot 等）在首次需要时完整构建。所有过滤后存活的 provider 行为与改前一致（`test/provider/lazy-catalog.test.ts` 回归锁定）。

### 3. 科学环境按需安装（`backend/cli/src/index.ts`）

启动不再自动预装 Python/R conda 环境（全新数据根曾触发 3.8 GB micromamba 安装与 UI 抢 CPU；已装数据根每次启动也要付两次解释器 import 探针）。缺失环境由首次内核请求按需走同一 lease-backed 安装；`OPENSCIENCE_PREWARM_ENVS=1` 可恢复旧的自动预热。实测：全新数据根启动不再创建 conda 目录，并输出一条 INFO 说明。

## 远程运行时

### 4. 桌面 SSH 连接管理器（`frontend/desktop/src/ssh-connections.mjs` 新增）

- 保存的 SSH 连接（label/host/user/port/identityFile/remotePort）持久化在 userData（0600）；损坏的存储文件会在覆写前移到旁路留存，不再可能被静默清空（独立评审确认并修复的问题）。
- 连接流程：探活 → 远程 sidecar 部署/升级（按版本比对，流式上传约 165MB，pid 文件温停旧进程）→ 启动远程 `serve` → 本地托管 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` 隧道（BatchMode、ExitOnForwardFailure、只绑回环）→ 健康检查后经既有确认框打开远程工作区窗口。
- 断线自动重连（≤3 次）；退出时清理全部隧道；所有子进程数组参数、带超时，无明文密码。
- 单元测试 `frontend/desktop/test/ssh-connections.test.mjs`（21 用例，含假 ssh 注入的状态机测试）。

### 5. 工作区 SSH 连接界面（`dialog-select-server.tsx` 等）

服务器选择对话框新增 SSH 区块（仅桌面环境显示）：连接列表 + 状态点、添加/编辑/删除表单、Connect/Disconnect；成功后由主进程打开远程窗口。桥接经 `preload.cjs → window.openscienceDesktop.ssh → platform`。

### 6. Docker 运行时镜像与远程使用文档

- `docker/Dockerfile.runtime`：ubuntu 22.04 + 非 root 用户 + sidecar 入口。
- `docker/build-runtime.sh`：从已构建 sidecar 组装镜像，打印本地/远程 run 示例。
- `docs/local-first/remote-runtime.md`：手动 SSH 隧道、SSH 管理器、Docker（本地与 `ssh host docker`）、安全边界（服务端固定 127.0.0.1，`-p` 端口发布触达不了 loopback-only 服务器，Linux 用 `--network host`——实测 `-p` 连接重置、host 网络 200）、断网语义与排障。

### 远程使用速览

```bash
# 方式一（零配置）：手动隧道
# 远程: openscience serve --port 4096   （systemd --user / tmux）
# 本地: ssh -N -L 4096:127.0.0.1:4096 user@host
# 桌面: Customize → Servers → Add http://127.0.0.1:4096

# 方式二（本轮新增）：桌面 SSH 管理器自动完成部署+隧道+开窗
```

本地断网不影响远程 agent 继续执行；重连后经 `/runtime/snapshot` 与 SSE `Last-Event-ID` 恢复。断线中的权限询问会等待，无人值守需 Full access / standing approval。

## 门禁与复核

- `backend/cli` 与 `frontend/workspace` tsgo typecheck 通过。
- `bun test test/provider/`：502 pass / 32 fail——32 个均为改造前既有失败（managed-route 依赖第一轮移除的账号会话 `getSession()=null`、bun 并行 flakiness），失败集合与基线逐字节一致，零新增；两个新测试文件全过。
- 桌面 SSH 测试 21 pass。
- 独立评审 1 条发现（SSH 存储损坏→保存静默清空）经独立确认员复现属实，已修复（损坏文件旁路留存 + 原子语义保存）。

---

# 第三轮改造：SSH 配置自动导入与本地自用版远程安装（2026-11-11）

## 1. 自动导入 `~/.ssh/config`（`frontend/desktop/src/ssh-connections.mjs`）

- 新增 `readSshConfig()` / `parseSshConfig()`：读取当前用户 `~/.ssh/config`，导入 `Host` 别名及其 `HostName`/`User`/`Port`/`IdentityFile`；支持 `Key=value`、引号值、`Include`（`~`、相对 `~/.ssh`、通配符、嵌套，深度 ≤8、文件 ≤64）。
- 通配符 Host 与 `Match` 块不导入（默认值/条件不是可连接别名）；同名别名取第一次声明，与 OpenSSH first-match 一致。
- 导入项是**派生记录**（`origin: "ssh-config"`、`alias`），每次 `list()` 重新读取，因此编辑配置文件后无需重启；UI 标记为只读（`~/.ssh/config` 徽标，隐藏 Remove），并提供 **Sync** 按钮。
- 手工记录优先：同 label 或同 host/user/port 的手工连接会遮蔽导入项，避免导入覆盖用户输入。
- 连接时只把别名交给 ssh（`ssh <alias>`），不追加 `-p`/`-i`/`user@`，`ProxyJump`、`Match`、`IdentitiesOnly` 等仍由 OpenSSH 解析。

## 2. 对面未安装时自动部署本地自用版 server

- 部署判定从“只看 VERSION”升级为“`BUILD` 标记的版本 + sha256”：同版本号但字节不同（例如上游发行版）也会被替换。
- 始终上传**桌面自带的 sidecar**（本地无遥测构建），不访问 GitHub 或任何下载源；上传后远端 `sha256sum` 与本地比对，不一致直接报错、不启动隧道。
- 写入 `~/.openscience/remote/BUILD`：`<version> <sha256> local-bundled`，同时保留 `VERSION` 兼容旧读取方。
- 事件文案显式标注 `(no telemetry)`，日志可追溯。

## 实测

- 本机 `~/.ssh/config` 的 3 个别名（debain / popos / agentbox）全部自动导入。
- 对 `debain`（Linux x86_64，Tailscale 直连）做真实端到端：导入 → 连接 → 上传本地 sidecar → 启动 → 隧道健康检查通过；`/global/health` 返回 `version: 2.0.153-local.2`；远端 `sha256sum` 与本地构建一致（`08cbb8f7…`，BUILD 标记 `local-bundled`）；测试后已停止远端进程并清理 `~/.openscience/remote`。
- `frontend/desktop/test/ssh-connections.test.mjs`：37 pass（新增 10 个用例：解析/Include/通配符、导入去重、只读、配置热更新、别名连接、同版本换字节重部署、远端摘要不一致拒绝）；`frontend/workspace` tsgo typecheck 通过。
