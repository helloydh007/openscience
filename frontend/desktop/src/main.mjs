import { randomBytes, createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from "electron"
import {
  apply as applyUpdate,
  current as currentUpdate,
  destination as updateDestination,
  discard as discardUpdate,
  durableJson,
  portable as portableUpdate,
  reconcileTransactions as reconcileUpdateTransactions,
  recover as recoverUpdate,
  launch as launchUpdate,
  stage as stageUpdate,
  stageCurrent,
  verify as verifyUpdate,
} from "./updater.mjs"
import { acknowledgedStartupResult, startupUpdateState } from "./update-state.mjs"
import { seedArchive } from "./update-download.mjs"
import { disposeRuntime } from "./runtime-disposal.mjs"
import { healthyRuntime, pinnedVersion } from "./service-health.mjs"
import { servicePort } from "./service-port.mjs"
import { logsDirectory, rotateLogs } from "./log-path.mjs"
import { readAppearance, resolveAppearance, saveAppearance, splashQuery, sweepAppearance } from "./appearance.mjs"
import { createSshManager } from "./ssh-connections.mjs"
import { createMemoryWatchdog, samplePidRss } from "./memory-watchdog.mjs"

import { workspaceOrigin, workspaceHealth, workspaceNavigation } from "./remote-workspace.mjs"

// Native Wayland on Linux: prefer the Ozone Wayland backend when the session
// provides one, keep client-side decorations, and enable fractional scaling
// and the Wayland IME. `ozone-platform-hint=auto` still falls back to X11 (and
// XWayland) when no Wayland display is present, so an X11 session keeps its
// existing behaviour. These switches must be set before the app is ready.
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations,WaylandFractionalScaleV1,EnableWaylandIme",
  )
  app.commandLine.appendSwitch("ozone-platform-hint", "auto")
}

// Renderer V8 heap ceiling: a runaway page hits a hard 4 GB limit instead of
// dragging the whole machine into the swap spiral. The 2026-11-15 OOM
// postmortem (memory-watchdog.mjs header) recorded one child at ~25 GB of
// anonymous memory on a machine whose swap was already exhausted.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096")

const execute = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const splashPage = fileURLToPath(new URL("./splash/splash.html", import.meta.url))
const windows = new Set()
const remoteWindows = new Set()
const connectingWindows = new Set()
// The only web permissions the workspace uses; every other request (camera,
// microphone, geolocation, MIDI, ...) is denied without prompting.
const permissions = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications"])
const state = {
  service: undefined,
  serviceExecutable: undefined,
  address: undefined,
  exiting: false,
  updateServer: undefined,
  updateAddress: undefined,
  updateToken: undefined,
  update: undefined,
  updateTask: undefined,
  updateAbort: undefined,
  updateCache: undefined,
  updateInstall: undefined,
  updateRestart: false,
  updateNoRuntime: false,
  updateRuntimeDisposed: false,
  updateMigrationRequired: false,
  runtimeLifecycle: "never_started",
  updateHelperLaunched: false,
  desktopParentToken: randomBytes(24).toString("hex"),
  updateTrusted: false,
  /** The running bundle's signature identity as verified at launch. */
  updateTrust: undefined,
  updateResult: undefined,
  updateRelaunch: undefined,
  updateStartupFailure: undefined,
  stopTask: undefined,
  /** The scheme and per-mode colours the workspace last reported; the splash and window paint from it before it mounts. */
  appearance: undefined,
  /** The tail of the serialized appearance writes, so the quit path can wait for the last one. */
  appearanceTask: undefined,
}

function appearanceFile() {
  return path.join(app.getPath("userData"), "appearance.json")
}

function appearance() {
  // Resolved at each paint, so a System scheme follows the OS as it is now.
  return resolveAppearance(state.appearance, nativeTheme.shouldUseDarkColors)
}

// The workspace owns its theme. Reading the tokens it resolved, and the scheme
// choice behind them, keeps the next launch's splash and window on the colours
// the workspace will paint, whichever theme or scheme the user picked, instead
// of a fixed dark that flashes on a light workspace. The storage key is the
// workspace's own (STORAGE_KEYS in frontend/ui/src/theme/context.tsx).
async function readAppearanceReport(window) {
  if (window.isDestroyed()) return
  // A window already torn down throws on webContents itself, not only in the
  // script, and a wedged renderer never answers at all; the quit path waits on
  // this, so it cannot wait forever.
  const probe = Promise.resolve()
    .then(() =>
      window.webContents.executeJavaScript(
        `(() => {
          const style = getComputedStyle(document.documentElement)
          let scheme = null
          try {
            scheme = localStorage.getItem("openscience-color-scheme")
          } catch {}
          return {
            mode: document.documentElement.dataset.colorScheme,
            scheme,
            theme: document.documentElement.dataset.theme,
            background: style.getPropertyValue("--background-base").trim(),
            foreground: style.getPropertyValue("--text-strong").trim(),
          }
        })()`,
      ),
    )
    .catch(() => undefined)
  return Promise.race([probe, new Promise((resolve) => setTimeout(resolve, 2_000))])
}

/**
 * One write at a time, in order: the theme-colour signal and the window's own
 * close can land together, and each fold reads the record the previous one left.
 */
function rememberAppearance(window) {
  state.appearanceTask = Promise.resolve(state.appearanceTask)
    .catch(() => undefined)
    .then(async () => {
      state.appearance = await saveAppearance(appearanceFile(), state.appearance, await readAppearanceReport(window))
    })
    .catch(() => undefined)
  return state.appearanceTask
}

function external(value) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") return
  void shell.openExternal(url.toString())
}

function localNavigation(value) {
  if (!state.address || !URL.canParse(value)) return false
  return new URL(value).origin === new URL(state.address).origin
}

function html(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function guiEnvironment() {
  const env = { ...process.env }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENSCIENCE_UPDATE_SKIP_LAUNCH",
    "OPENSCIENCE_UPDATE_TEST_SKIP_FALLBACK",
    "OPENSCIENCE_UPDATE_TEST_HEALTH_FAILURE",
    "OPENSCIENCE_UPDATE_TEST_SWAP_EXECUTABLE",
  ]) {
    delete env[key]
  }
  return env
}

function relaunchAfterExit(bundle) {
  if (!path.isAbsolute(bundle) || path.basename(bundle) !== "OpenScience.app") {
    throw new Error("The recovered OpenScience application path is invalid")
  }
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open -n "$2"',
      "openscience-update-recovery",
      String(process.pid),
      bundle,
    ],
    { detached: true, env: guiEnvironment(), stdio: "ignore" },
  )
  child.unref()
}

function binary() {
  if (process.env.OPENSCIENCE_DESKTOP_SIDECAR) return path.resolve(process.env.OPENSCIENCE_DESKTOP_SIDECAR)
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sidecar", process.platform === "win32" ? "openscience.exe" : "openscience")
  }
  const platform = process.platform === "win32" ? "windows" : process.platform
  const suffix = process.platform === "win32" ? ".exe" : ""
  return path.join(
    root,
    "backend",
    "cli",
    "dist",
    "@synsci",
    `openscience-${platform}-${process.arch}`,
    "bin",
    `openscience${suffix}`,
  )
}

// The sidecar listens well under a second after spawn. Probe again quickly
// once, then settle into a slower cadence so a slow disk does not turn the
// wait into a busy loop; the workspace URL loads the moment health passes.
const READY_FIRST_RETRY_MS = 100
const READY_RETRY_MS = 250
const LOG_TAIL_LINES = 20

function logTail(file, lines = LOG_TAIL_LINES) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n")
  } catch {
    return ""
  }
}

function startupExitMessage(exit, output) {
  const reason = exit.signal ? `was terminated by ${exit.signal}` : `exited with code ${exit.code}`
  const tail = logTail(output)
  return [
    `The local OpenScience service ${reason} before it was ready.`,
    `Log: ${output}`,
    ...(tail ? ["", tail] : []),
  ].join("\n")
}

// The sidecar's exit is raced against the health probes so a crash at startup
// fails immediately with its exit status and log tail instead of waiting out
// the 30 second deadline. `close` (not `exit`) guarantees the last stdio data
// has already been appended to the log file.
async function ready(url, service, output) {
  const deadline = Date.now() + 30_000
  const probe = () =>
    fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let exit
  const closed = new Promise((resolve) => {
    service.once("close", (code, signal) => {
      exit = { code, signal }
      resolve(false)
    })
  })
  const poll = async () => {
    if (await probe()) return true
    await pause(READY_FIRST_RETRY_MS)
    while (Date.now() < deadline && !exit) {
      if (await probe()) return true
      await pause(READY_RETRY_MS)
    }
    return false
  }
  if (await Promise.race([poll(), closed])) return
  if (exit) throw new Error(startupExitMessage(exit, output))
  throw new Error(`The local OpenScience service did not start within 30 seconds.\nLog: ${output}`)
}

function updateHealthRequest() {
  const prefix = "--openscience-update-health="
  const encoded = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
  if (!encoded) return
  if (encoded.length > 4_096) throw new Error("The desktop update health request is too large")
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
}

function validateUpdateHealthRequest() {
  const request = updateHealthRequest()
  if (!request || !state.updateCache) return
  if (
    typeof request.receipt !== "string" ||
    !path.isAbsolute(request.receipt) ||
    typeof request.runtime !== "string" ||
    !path.isAbsolute(request.runtime) ||
    !/^[0-9a-f]{48}$/.test(request.token ?? "") ||
    request.version !== app.getVersion()
  ) {
    throw new Error("The desktop update health request is invalid")
  }
  const relative = path.relative(state.updateCache, request.receipt)
  const runtimeRelative = path.relative(state.updateCache, request.runtime)
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "." ||
    path.basename(request.receipt) !== `health-${request.token}.json` ||
    !runtimeRelative ||
    runtimeRelative.startsWith("..") ||
    path.isAbsolute(runtimeRelative) ||
    path.dirname(runtimeRelative) !== "." ||
    path.basename(request.runtime) !== `runtime-${request.token}.json`
  ) {
    throw new Error("The desktop update health receipt escaped the update cache")
  }
  return request
}

async function processIdentity(pid, executable) {
  const [started, command] = await Promise.all([
    execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], { timeout: 2_000 }),
    execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 2_000 }),
  ])
  const exact = path.resolve(executable)
  const observedCommand = command.stdout.trim()
  if (!started.stdout.trim() || (observedCommand !== exact && !observedCommand.startsWith(`${exact} `))) {
    throw new Error(`OpenScience could not bind startup health to process ${pid}`)
  }
  return { pid, started: started.stdout.trim(), executable: exact, command: observedCommand }
}

async function proveServiceHealth() {
  const service = state.service
  if (
    !service ||
    !service.pid ||
    !state.serviceExecutable ||
    service.exitCode !== null ||
    service.signalCode !== null ||
    !state.address
  ) {
    throw new Error("The local OpenScience runtime exited before desktop startup completed")
  }
  const response = await fetch(`${state.address}/global/health`, { signal: AbortSignal.timeout(3_000) }).catch(
    () => undefined,
  )
  const health = await response
    ?.json()
    .then((value) => value)
    .catch(() => undefined)
  const request = validateUpdateHealthRequest()
  const version = pinnedVersion({
    packaged: app.isPackaged,
    sidecar: Boolean(process.env.OPENSCIENCE_DESKTOP_SIDECAR),
    supervised: Boolean(request),
    version: app.getVersion(),
  })
  if (!response?.ok || !healthyRuntime(health, version) || service.exitCode !== null || service.signalCode !== null) {
    throw new Error("The local OpenScience runtime failed its final desktop health check")
  }
  // Nothing else records which runtime an unpinned shell ended up talking to.
  if (version === undefined) {
    process.stderr.write(`[openscience] sidecar reports version ${health.version}; shell is ${app.getVersion()}\n`)
  }
  return {
    // Exact process identity belongs to the supervised macOS update receipt.
    // Ordinary startup still checks runtime health on every platform.
    identity: request ? await processIdentity(service.pid, state.serviceExecutable) : undefined,
    health: { version: health.version, run_id: health.runId },
  }
}

async function writeUpdateHealth(value) {
  const request = validateUpdateHealthRequest()
  if (!request) return
  const identity = await processIdentity(process.pid, process.execPath)
  const temporary = `${request.receipt}.tmp-${process.pid}`
  await writeFile(
    temporary,
    `${JSON.stringify({
      ...value,
      token: request.token,
      version: request.version,
      process_identity: identity,
    })}\n`,
    { mode: 0o600 },
  )
  await rename(temporary, request.receipt)
  return request
}

async function acknowledgeUpdateHealth() {
  const service = await proveServiceHealth()
  // Keep the helper supervising this exact startup until recovery has settled.
  // Publishing terminal health first lets the helper clean its journal while
  // this main is still reconciling the same transaction.
  await reconcileCurrentUpdate(true)
  // Older helpers erase their ZIP after health succeeds. Retain it locally first,
  // so this first upgrade already supplies the next differential baseline.
  if (state.updateCache)
    await seedArchive(state.updateCache, validateUpdateHealthRequest(), `OpenScience-mac-${process.arch}.zip`).catch(
      () => undefined,
    )
  const request = await writeUpdateHealth({
    healthy: true,
    pid: process.pid,
    service_identity: service.identity,
    service_health: service.health,
  })
  if (!request) return
  state.updateResult = {
    phase: "succeeded",
    version: request.version,
    completed_at: new Date().toISOString(),
  }
}

async function acknowledgeUpdatePending() {
  return writeUpdateHealth({ status: "pending", pid: process.pid })
}

async function acknowledgeUpdateFailure(error, safeToTerminate = false) {
  return writeUpdateHealth({
    healthy: false,
    safe_to_terminate: safeToTerminate,
    pid: process.pid,
    error: error instanceof Error ? error.message : String(error),
  })
}

async function start() {
  const executable = binary()
  if (!existsSync(executable)) throw new Error(`OpenScience runtime is missing: ${executable}`)
  const selected = await servicePort(path.join(app.getPath("userData"), "service-port.json"))
  const workspace = path.join(app.getPath("userData"), "workspace")
  const logs = app.getPath("logs")
  const output = path.join(logs, "openscience-sidecar.log")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(logs, { recursive: true })
  // Keep earlier runs' output: a failed start is otherwise wiped by the very
  // relaunch made to investigate it.
  rotateLogs(output)
  writeFileSync(output, "", { mode: 0o600 })
  state.address = `http://127.0.0.1:${selected}`
  state.serviceExecutable = path.resolve(executable)
  const healthRequest = validateUpdateHealthRequest()
  state.runtimeLifecycle = "spawning"
  try {
    state.service = spawn(executable, ["serve", "--port", String(selected), "--print-logs"], {
      cwd: workspace,
      env: {
        ...process.env,
        ...(state.updateAddress && state.updateToken
          ? {
              OPENSCIENCE_DESKTOP_UPDATE_URL: `${state.updateAddress}/update`,
              OPENSCIENCE_DESKTOP_UPDATE_TOKEN: state.updateToken,
            }
          : {}),
        OPENSCIENCE_DESKTOP_PARENT_PID: String(process.pid),
        OPENSCIENCE_DESKTOP_PARENT_TOKEN: state.desktopParentToken,
        ...(healthRequest
          ? {
              OPENSCIENCE_DESKTOP_PARENT_RUNTIME_RECEIPT: healthRequest.runtime,
              OPENSCIENCE_DESKTOP_PARENT_UPDATE_TOKEN: healthRequest.token,
              OPENSCIENCE_DESKTOP_PARENT_UPDATE_VERSION: healthRequest.version,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (error) {
    state.runtimeLifecycle = "never_started"
    throw error
  }
  state.runtimeLifecycle = "running"
  state.service.stdout?.on("data", (value) => {
    appendFileSync(output, value)
    if (!app.isPackaged) process.stdout.write(`[openscience] ${value}`)
  })
  state.service.stderr?.on("data", (value) => {
    appendFileSync(output, value)
    if (!app.isPackaged) process.stderr.write(`[openscience] ${value}`)
  })
  state.service.on("exit", (code, signal) => {
    if (state.exiting) return
    // The sandboxed renderer has no preload, so there is no IPC receiver;
    // record the unexpected exit next to the sidecar's own output instead.
    appendFileSync(output, `[desktop] OpenScience runtime exited unexpectedly (${signal ?? `code ${code}`})\n`)
  })
  await ready(state.address, state.service, output)
}

function respond(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  response.end(JSON.stringify(value))
}

function updateView() {
  if (!state.update) {
    return state.updateResult ?? { phase: "idle" }
  }
  const { phase, version, transferred, total, error } = state.update
  return {
    phase,
    version,
    transferred,
    total,
    progress: total && transferred !== undefined ? Math.min(1, transferred / total) : undefined,
    error,
    migration_required: state.updateMigrationRequired,
  }
}

function prepareUpdate(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("The desktop update version is invalid")
  if (state.updateRestart) throw new Error("OpenScience is already committed to restarting for this update")
  if (state.update && state.update.version !== version && state.update.phase !== "failed") {
    throw new Error(`OpenScience ${state.update.version} is already staged or downloading`)
  }
  if (state.update?.phase === "ready" || state.updateTask) return
  state.updateResult = undefined
  const controller = new AbortController()
  state.updateAbort = controller
  state.update = { phase: "downloading", version, transferred: 0, total: undefined }
  const current = currentUpdate()
  const task = stageUpdate(version, {
    cache: state.updateCache,
    current,
    currentVersion: app.getVersion(),
    trusted: true,
    signal: controller.signal,
    onProgress(progress) {
      if (state.update?.version !== version) return
      Object.assign(state.update, progress)
    },
  })
    .then((prepared) => {
      if (controller.signal.aborted) return discardUpdate(prepared)
      state.update = { phase: "ready", version, prepared }
    })
    .catch((error) => {
      state.update = controller.signal.aborted
        ? undefined
        : { phase: "failed", version, error: error instanceof Error ? error.message : String(error) }
    })
    .finally(() => {
      if (state.updateTask === task) state.updateTask = undefined
      if (state.updateAbort === controller) state.updateAbort = undefined
    })
  state.updateTask = task
}

async function updateRequest(request, response) {
  if (request.url !== "/update" || !["GET", "POST", "DELETE"].includes(request.method)) {
    respond(response, 404, { error: "Not found" })
    return
  }
  if (request.headers.authorization !== `Bearer ${state.updateToken}`) {
    respond(response, 401, { error: "Unauthorized" })
    return
  }
  if (request.method === "GET") {
    respond(response, 200, updateView())
    return
  }
  if (request.method === "DELETE") {
    if (state.updateRestart) {
      respond(response, 409, { error: "OpenScience is already finishing this update restart" })
      return
    }
    state.updateAbort?.abort()
    await state.updateTask?.catch(() => undefined)
    if (state.update?.phase === "ready") await discardUpdate(state.update.prepared)
    state.update = undefined
    state.updateResult = undefined
    respond(response, 200, { phase: "idle" })
    return
  }
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
    if (chunks.reduce((size, value) => size + value.length, 0) > 16_384) {
      respond(response, 413, { error: "Update request is too large" })
      return
    }
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (typeof input.version !== "string") throw new Error("The desktop update version is missing")
  if (input.action === "stage") {
    if (state.updateRestart) {
      respond(response, 409, { error: "OpenScience is already finishing this update restart" })
      return
    }
    prepareUpdate(input.version)
    respond(response, 202, updateView())
    return
  }
  if (input.action !== "apply") throw new Error("The desktop update action is invalid")
  if (state.update?.phase === "restart_blocked" && state.update.version === input.version) {
    if (state.updateHelperLaunched) {
      respond(response, 409, { error: "The prepared update restart can no longer be retried safely" })
      return
    }
    if (state.updateRestart && state.updateInstall) {
      // The handoff is still armed: only the drain failed. Try the drain again.
      state.update = { ...state.update, phase: "restarting", error: undefined }
      respond(response, 202, updateView())
      const timer = setTimeout(() => void stop(), 0)
      timer.unref?.()
      return
    }
    // The latch was released after a failed handoff; the staged bundle is
    // still verified and ready, so prepare the restart again from scratch.
    state.update = { ...state.update, phase: "ready", error: undefined }
  }
  if (state.update?.phase !== "ready" || state.update.version !== input.version) {
    respond(response, 409, { error: `OpenScience ${input.version} is not verified and ready to restart` })
    return
  }
  if (state.updateRestart) {
    respond(response, 409, { error: "OpenScience is already preparing this update restart" })
    return
  }
  const update = state.update.prepared
  state.updateRestart = true
  try {
    state.updateInstall = await applyUpdate(update, {
      current: currentUpdate(),
      trusted: true,
      allowUserMigration: state.updateMigrationRequired,
    })
  } catch (error) {
    state.updateRestart = false
    throw error
  }
  state.update = { phase: "restarting", version: update.version, prepared: update }
  respond(response, 202, updateView())
  const timer = setTimeout(() => {
    void stop()
  }, 750)
  timer.unref?.()
}

async function updates() {
  if (!app.isPackaged || process.platform !== "darwin") return
  state.updateCache = path.join(app.getPath("userData"), "updates")
  state.updateTrust = await verifyUpdate(currentUpdate(), app.getVersion(), { trusted: true, running: true }).catch(
    (error) => {
      console.warn(
        `Automatic updates are unavailable because this app is not a notarized Developer ID build: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return undefined
    },
  )
  state.updateTrusted = Boolean(state.updateTrust)
  if (!state.updateTrusted) return
  const active = currentUpdate()
  state.updateMigrationRequired =
    !portableUpdate(active) &&
    (await updateDestination(active, { allowUserMigration: true }).then((target) => target !== active))
  const interrupted = await reconcileCurrentUpdate()
  if (interrupted.inProgress) {
    throw new Error(
      "A verified OpenScience update is already being installed. Wait for it to finish and reopen the app.",
    )
  }
  if (interrupted.relaunch) {
    state.updateRelaunch = interrupted.relaunch
    throw new Error("OpenScience restored the previous app after an interrupted update")
  }
  const resultFile = path.join(state.updateCache, "last-result.json")
  const stored = await readFile(resultFile, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => undefined)
  state.updateResult = startupUpdateState(stored, app.getVersion(), validateUpdateHealthRequest()?.version)
  const acknowledged = acknowledgedStartupResult(stored, state.updateResult)
  // Serving "Updated to X" is what spends it. Recording that on disk, rather
  // than only removing the file, means a result written again by update
  // recovery cannot replay the notice on a later launch either. It goes down
  // through the same durable write as the helper's own receipts, so a power
  // cut right after it cannot bring the notice back. It is still only a safety
  // net for a notice already shown, never a reason to refuse the launch, so a
  // cache that will not take the write is ignored.
  if (acknowledged) await durableJson(resultFile, acknowledged).catch(() => undefined)
  else if (stored) await rm(resultFile, { force: true })
  const recovered = updateHealthRequest()
    ? undefined
    : await recoverUpdate(state.updateCache, {
        current: currentUpdate(),
        currentVersion: app.getVersion(),
        trusted: true,
      })
  if (recovered && state.updateResult?.phase === "failed") await discardUpdate(recovered)
  else if (recovered) state.update = { phase: "ready", version: recovered.version, prepared: recovered }
  state.updateToken = randomBytes(32).toString("hex")
  state.updateServer = createServer((request, response) => {
    void updateRequest(request, response).catch((error) => {
      respond(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  state.updateServer.unref()
  await new Promise((resolve, reject) => {
    state.updateServer.once("error", reject)
    state.updateServer.listen(0, "127.0.0.1", resolve)
  })
  const address = state.updateServer.address()
  if (typeof address !== "object" || !address) throw new Error("The desktop update service did not start")
  state.updateAddress = `http://127.0.0.1:${address.port}`
}

async function reconcileCurrentUpdate(healthyCurrent) {
  if (!app.isPackaged || process.platform !== "darwin" || !state.updateCache) return {}
  const supervised = validateUpdateHealthRequest()
  return reconcileUpdateTransactions(state.updateCache, {
    current: currentUpdate(),
    currentVersion: app.getVersion(),
    trusted: true,
    // Established at launch; reconciliation must not re-verify the running
    // bundle deep on every start.
    ...(state.updateTrust ? { trust: state.updateTrust } : {}),
    swapExecutable: binary(),
    ...(supervised ? { supervised } : {}),
    ...(typeof healthyCurrent === "boolean" ? { healthyCurrent } : {}),
  })
}

async function bootstrap(splash) {
  if (!app.isPackaged || process.platform !== "darwin") return false
  const bundle = currentUpdate()
  if (!portableUpdate(bundle)) return false
  if (!state.updateTrusted) {
    const prompt = await dialog.showMessageBox(splash, {
      type: "warning",
      buttons: ["Download verified installer", "Run from Disk Image"],
      defaultId: 0,
      cancelId: 1,
      message: "This copy cannot install automatic updates",
      detail:
        "Automatic installation requires the signed and notarized OpenScience release. Download the verified installer, or continue without installing this copy.",
    })
    if (prompt.response === 0) {
      await shell.openExternal("https://github.com/synthetic-sciences/openscience/releases/latest")
    }
    return false
  }
  const prompt = await dialog.showMessageBox(splash, {
    type: "info",
    buttons: ["Install OpenScience", "Run from Disk Image"],
    defaultId: 0,
    cancelId: 1,
    message: "Finish installing OpenScience",
    detail:
      "OpenScience is running from the downloaded disk image. Install it in Applications now so future updates work automatically.",
  })
  if (prompt.response !== 0) return false
  await splash.loadFile(splashPage, { query: splashQuery(appearance(), "install") })
  let staged
  try {
    staged = await stageCurrent({
      cache: path.join(app.getPath("userData"), "updates"),
      current: bundle,
      trusted: true,
    })
    const prepared = await applyUpdate(staged, { current: bundle, trusted: true })
    state.updateInstall = prepared
    state.updateRestart = true
    // Bootstrap runs before the backend sidecar has ever started. That
    // absence is the runtime-disposal proof for this first installation.
    state.updateNoRuntime = true
    state.update = { phase: "restarting", version: prepared.version }
  } catch (error) {
    if (staged) await discardUpdate(staged).catch(() => undefined)
    state.updateInstall = undefined
    state.updateRestart = false
    state.updateNoRuntime = false
    state.updateRuntimeDisposed = false
    state.update = undefined
    await dialog.showMessageBox(splash, {
      type: "error",
      buttons: ["Continue from Disk Image"],
      message: "OpenScience could not finish installing",
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
  splash.destroy()
  const timer = setTimeout(() => void stop(), 250)
  timer.unref?.()
  return true
}

function dock() {
  if (process.platform !== "darwin" || !app.dock) return
  const entries = [...windows].map((window, index) => ({
    label: window.getTitle() || `OpenScience ${index + 1}`,
    click: () => {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },
  }))
  app.dock.setMenu(
    Menu.buildFromTemplate([
      ...(entries.length ? [...entries, { type: "separator" }] : []),
      { label: "New Window", click: () => void createWindow() },
    ]),
  )
}

function waitForExit(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeout)
    const finish = (exited) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once("exit", onExit)
  })
}

async function closeUpdateServer() {
  const server = state.updateServer
  state.updateServer = undefined
  if (!server) return
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error)
      else resolve()
    })
    server.closeAllConnections?.()
  })
}

async function drainService() {
  const service = state.service
  const updateRestart = state.updateRestart || Boolean(updateHealthRequest())
  if (updateRestart && state.updateRuntimeDisposed) return
  if (!service || service.exitCode !== null || service.signalCode !== null) {
    if (updateRestart && !service && (state.updateNoRuntime || state.runtimeLifecycle === "never_started")) {
      state.updateRuntimeDisposed = true
      state.runtimeLifecycle = "disposed"
      return
    }
    if (updateRestart) {
      throw new Error("OpenScience could not prove that the local runtime exited without leaving active work behind")
    }
    return
  }
  if (updateRestart && (!state.address || !state.updateToken)) {
    throw new Error("OpenScience could not prove that the local runtime was safely disposed before updating")
  }
  if (state.address && state.updateToken) {
    await disposeRuntime(state.address, state.updateToken).catch((error) => {
      if (updateRestart) throw error
      console.warn(error instanceof Error ? error.message : String(error))
    })
  }
  service.kill("SIGTERM")
  if (await waitForExit(service, 5_000)) {
    if (updateRestart) {
      state.updateRuntimeDisposed = true
      state.runtimeLifecycle = "disposed"
    }
    return
  }
  service.kill("SIGKILL")
  if (!(await waitForExit(service, 2_000))) {
    throw new Error("The local OpenScience service did not stop safely")
  }
  if (updateRestart) {
    state.updateRuntimeDisposed = true
    state.runtimeLifecycle = "disposed"
  }
}

function stop() {
  if (state.stopTask) return state.stopTask
  state.exiting = true
  state.stopTask = (async () => {
    // Quit destroys the windows rather than closing them, so their `close`
    // handler never runs: read what they painted while the renderers are alive.
    // Bounded, because quitting must not wait on a renderer that stopped answering.
    await Promise.race([
      Promise.all(Array.from(windows, (window) => rememberAppearance(window))),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
    await drainService()
    if (state.updateStartupFailure) {
      await acknowledgeUpdateFailure(state.updateStartupFailure, true)
    }
    if (state.updateRestart && state.updateInstall && !state.updateHelperLaunched) {
      await launchUpdate(state.updateInstall)
      state.updateHelperLaunched = true
      // The helper is now armed with a durable proof that the old runtime was
      // disposed. From this point forward Electron must exit; a close error on
      // the already-unreferenced loopback server cannot reopen admission.
      await closeUpdateServer().catch((error) => console.warn(error instanceof Error ? error.message : String(error)))
    } else {
      await closeUpdateServer()
    }
    for (const window of windows) window.destroy()
    app.exit(0)
  })().catch((error) => {
    state.exiting = false
    state.stopTask = undefined
    if (state.updateRestart && !state.updateHelperLaunched) {
      // The handoff did not happen, so nothing is committed: release the
      // latch. Otherwise every later action dead-ends on it: Retry and
      // Discard answer 409 "already restarting", and Quit demands proof of a
      // disposal that never happened. The staged update stays ready; the
      // person can retry (apply() only prepares an in-memory payload),
      // discard it, or quit normally.
      state.updateRestart = false
      state.updateInstall = undefined
      state.updateRuntimeDisposed = false
      if (state.update?.phase === "restarting") {
        state.update = {
          ...state.update,
          phase: "restart_blocked",
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    dialog.showErrorBox("OpenScience could not quit safely", error instanceof Error ? error.message : String(error))
  })
  return state.stopTask
}

function applicationMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: `Quit ${app.name}`, accelerator: "CmdOrCtrl+Q", click: () => void stop() },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => void createWindow() },
        { type: "separator" },
        process.platform === "darwin"
          ? { role: "close" }
          : { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => void stop() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...(app.isPackaged ? [] : [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }]),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(remote) {
  if (!state.address) return
  const origin = remote ? workspaceOrigin(remote) : new URL(state.address).origin
  const remoteSession = remote
    ? session.fromPartition(`persist:workspace-${createHash("sha256").update(origin).digest("hex")}`)
    : undefined
  remoteSession?.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissions.has(permission) && workspaceNavigation(details?.requestingUrl || contents.getURL(), origin))
  })
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "OpenScience",
    backgroundColor: appearance().background,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(remoteSession
        ? { session: remoteSession }
        : { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)) }),
    },
  })
  windows.add(window)
  if (remote) remoteWindows.add(window)
  window.once("ready-to-show", () => window.show())
  window.on("page-title-updated", (event, title) => {
    if (remote) {
      event.preventDefault()
      window.setTitle(`${new URL(origin).host} — ${title}`)
    }
    dock()
  })
  window.on("focus", dock)
  window.on("close", () => void rememberAppearance(window))
  // The workspace repaints <meta name="theme-color"> with the background token
  // it just resolved (applyThemeCss in frontend/ui/src/theme/context.tsx), so
  // Chromium's theme-colour change is the renderer telling the shell that the
  // theme or the scheme moved. Without it a mid-session change reached the file
  // only if the close-time write won its race with the quit.
  window.webContents.on("did-change-theme-color", () => void rememberAppearance(window))
  window.on("closed", () => {
    windows.delete(window)
    remoteWindows.delete(window)
    if (!state.exiting) dock()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (workspaceNavigation(url, origin)) return
    event.preventDefault()
    external(url)
  })
  window.webContents.on("will-redirect", (event, url) => {
    if (workspaceNavigation(url, origin)) return
    event.preventDefault()
    external(url)
  })
  try {
    await window.loadURL(
      `${origin}/?desktop=1${remote ? "&remote-workspace=1" : state.updateAddress ? "&desktop-update=1" : ""}`,
    )
  } catch (error) {
    window.destroy()
    throw error
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const mounted = await window.webContents
      .executeJavaScript('document.documentElement.dataset.openscienceReady === "true"')
      .catch(() => false)
    if (mounted) {
      dock()
      void rememberAppearance(window)
      return window
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The OpenScience workspace did not finish mounting within 30 seconds.")
}

const lock = app.requestSingleInstanceLock()
if (!lock) app.exit(0)

// Managed SSH connections: stored records, remote sidecar deployment, and the
// loopback tunnel a remote workspace opens through. Events fan out to local
// windows only; remote workspace windows have no preload and must never learn
// about SSH infrastructure.
const sshManager = createSshManager({
  userData: app.getPath("userData"),
  sidecarPath: binary(),
  version: app.getVersion(),
})
sshManager.onEvent((event) => {
  // A runtime tunnel that dies for good — retries exhausted, or a failed
  // connect of its own — falls back to the local sidecar the same way an
  // explicit disconnect does. Without this the workspace would keep aiming
  // every request at a dead tunnel until the person reconnected by hand.
  // The check is "still this selection", so a fallback cannot clobber a
  // runtime the person picked meanwhile.
  if (event.state === "failed" && sshManager.runtime() === event.connectionId) {
    try {
      sshManager.setRuntime(null)
      pushServerUse(state.address, "")
    } catch {}
  }
  for (const window of windows) {
    if (!remoteWindows.has(window) && !window.isDestroyed()) window.webContents.send("openscience:ssh:event", event)
  }
})

function sshSender(event) {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || !windows.has(owner) || remoteWindows.has(owner) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Only the local workspace can manage SSH connections")
  }
  return owner
}

/**
 * Tells local windows which server the workspace runs on: a remote runtime's
 * tunnel URL, or back to the local sidecar with an empty connection id. Local
 * windows only — remote workspace windows have no preload and must never learn
 * about SSH infrastructure — mirroring the ssh event fan-out above. The quit
 * path never pushes: once exiting is set, windows are about to be destroyed.
 */
function pushServerUse(url, connectionId) {
  if (state.exiting) return
  for (const window of windows) {
    if (!remoteWindows.has(window) && !window.isDestroyed()) {
      window.webContents.send("openscience:server:use", { url, connectionId })
    }
  }
}

/**
 * Widens connect-src on loopback-served pages so the workspace can reach a
 * runtime tunnel. The switch happens while the page is already mounted: the
 * sidecar's CSP header (`connect-src 'self'`, backend/cli/src/web/csp.ts) was
 * fixed at load time, and the tunnel's port only exists once a connection is
 * up, so the header must already allow any loopback origin for the in-place
 * switch to work. Only connect-src grows, only over http/ws loopback — exactly
 * the hosts an SSH tunnel may use (workspaceOrigin accepts no other HTTP) —
 * and remote workspace windows are untouched: they run in their own
 * persist:workspace-* partitions and keep their same-origin policy.
 */
function relaxLoopbackConnectSrc(url, headers) {
  if (!headers || !URL.canParse(url)) return headers
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return headers
  const widened = {}
  for (const [name, values] of Object.entries(headers)) {
    widened[name] =
      /^content-security-policy$/i.test(name) && Array.isArray(values)
        ? values.map((value) =>
            value.replace(/connect-src(\s+'self')/g, `connect-src$1 http://127.0.0.1:* ws://127.0.0.1:*`),
          )
        : values
  }
  return widened
}

/**
 * The onTunnelUp hook for a runtime-mode connect: remember the selection for
 * the next launch and switch every local window to the tunnel. No confirm and
 * no new window. A record removed while connecting makes setRuntime throw, and
 * connect reports that failure like any other.
 *
 * The restore path passes `restore: true`: while its tunnel is coming up —
 * deploy and upload can take minutes — the person may have selected another
 * runtime, and that fresher choice wins. The tunnel that arrives last then
 * reports `false`, so connect tears it back down instead of switching every
 * window back to a stale selection.
 */
function runtimeTunnelUp(id, { restore = false } = {}) {
  return (url) => {
    if (restore) {
      const current = sshManager.runtime()
      if (current !== null && current !== id) return false
    }
    sshManager.setRuntime(id)
    pushServerUse(url, id)
    return true
  }
}

/**
 * Restores the runtime connection the previous session selected. Called after
 * the first window exists and never blocks startup: the tunnel comes up in the
 * background and the workspace learns about it through openscience:server:use.
 * A failed restore — for example a record deleted since — only clears the
 * stale selection and reports one line on stderr; the workspace stays local.
 */
async function restoreRuntime() {
  const id = sshManager.runtime()
  if (!id) return
  let result
  try {
    result = await sshManager.connect(id, { onTunnelUp: runtimeTunnelUp(id, { restore: true }) })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (result?.ok) return
  try {
    // Only clear the selection this restore owns, so a choice made meanwhile wins.
    if (sshManager.runtime() === id) sshManager.setRuntime(null)
  } catch {}
  process.stderr.write(
    `[openscience] The runtime SSH connection ${id} was not restored: ${String(result?.error ?? "unknown reason").replace(/\s*\r?\n\s*/g, " ")}\n`,
  )
}

ipcMain.handle("openscience:ssh:list", (event) => {
  sshSender(event)
  return sshManager.list()
})

ipcMain.handle("openscience:ssh:sync", (event) => {
  sshSender(event)
  return sshManager.sync()
})

ipcMain.handle("openscience:ssh:save", (event, input) => {
  sshSender(event)
  return sshManager.save(input)
})

ipcMain.handle("openscience:ssh:remove", async (event, id) => {
  sshSender(event)
  await sshManager.remove(id)
  // The removed connection was the selected runtime: fall back to the local
  // server. setRuntime(null) persists only; the workspace learns of the
  // switch through the broadcast below.
  if (sshManager.runtime() === id) {
    sshManager.setRuntime(null)
    pushServerUse(state.address, "")
  }
})

ipcMain.handle("openscience:ssh:disconnect", async (event, id) => {
  sshSender(event)
  await sshManager.disconnect(id)
  // Same fallback as remove: a disconnected runtime leaves the workspace local.
  if (sshManager.runtime() === id) {
    sshManager.setRuntime(null)
    pushServerUse(state.address, "")
  }
})

ipcMain.handle("openscience:ssh:set-runtime", (event, id) => {
  sshSender(event)
  sshManager.setRuntime(id)
})

ipcMain.handle("openscience:ssh:runtime", (event) => {
  sshSender(event)
  return sshManager.runtime()
})

ipcMain.handle("openscience:ssh:connect", async (event, id, purpose) => {
  const owner = sshSender(event)
  // Runtime mode: this connection becomes the workspace's own server. No
  // confirm and no new window — the selection is remembered for the next
  // launch and every local window switches to the tunnel through
  // openscience:server:use.
  if (purpose === "runtime") {
    return sshManager.connect(id, { onTunnelUp: runtimeTunnelUp(id) })
  }
  return sshManager.connect(id, {
    // The tunnel is up; the workspace window opens only once the person
    // confirms, and cancelling tears the tunnel back down. Mirrors the
    // open-workspace confirm dialog.
    onTunnelUp: async (url) => {
      const prompt = await dialog.showMessageBox(owner, {
        type: "question",
        buttons: ["Open workspace", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: `Open workspace at ${url}?`,
        detail:
          "This window will use the OpenScience server running on the remote host through the SSH tunnel. Only connect to a runtime you trust. Your local workspace stays open.",
      })
      if (prompt.response !== 0 || owner.isDestroyed()) return false
      try {
        await createWindow(url)
      } catch (error) {
        dialog.showErrorBox(
          "OpenScience could not open the remote workspace",
          error instanceof Error ? error.message : String(error),
        )
        return false
      }
      return true
    },
  })
})

ipcMain.handle("openscience:open-workspace", async (event, value) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (
    !owner ||
    !windows.has(owner) ||
    remoteWindows.has(owner) ||
    event.senderFrame !== event.sender.mainFrame ||
    !localNavigation(event.senderFrame.url)
  ) {
    throw new Error("Only the local workspace can open a remote workspace")
  }
  if (connectingWindows.has(owner)) throw new Error("A workspace connection is already being opened")
  connectingWindows.add(owner)
  try {
    const target = await workspaceHealth(value)
    const result = await dialog.showMessageBox(owner, {
      type: "question",
      buttons: ["Open workspace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Open workspace at ${target.origin}?`,
      detail:
        "This window will use that server's files, tools, and accounts. Only connect to an OpenScience runtime you trust. Your local workspace stays open.",
    })
    if (result.response !== 0 || owner.isDestroyed()) return false
    await createWindow(target.origin)
    return true
  } finally {
    connectingWindows.delete(owner)
  }
})

app.on("second-instance", () => {
  void createWindow()
})

app
  .whenReady()
  .then(async () => {
    let splash
    try {
      app.name = "OpenScience"
      // Before the first read of the logs path: Electron fixes its default on that read, and on macOS the
      // default belongs to the installed app whatever `--user-data-dir` says.
      const logs = logsDirectory({
        packaged: app.isPackaged,
        relocated: app.commandLine.hasSwitch("user-data-dir"),
        userData: app.getPath("userData"),
      })
      if (logs) app.setAppLogsPath(logs)
      // Memory watchdog: contains a runaway child before the machine enters
      // the swap spiral, and leaves a per-process telemetry trail that names
      // the culprit the next time the kernel OOM report does not.
      if (!process.env.OPENSCIENCE_NO_MEMORY_WATCHDOG) {
        const telemetryFile = path.join(logs ?? app.getPath("userData"), "memory-watchdog.log")
        createMemoryWatchdog({
          metrics: () => app.getAppMetrics(),
          sidecarSample: () => ({ pid: state.service?.pid, rssMb: samplePidRss(state.service?.pid) }),
          crashRenderer: (pid) => {
            for (const window of windows) {
              if (window.isDestroyed() || remoteWindows.has(window)) continue
              if (window.webContents.getProcessId() === pid) {
                window.webContents.forcefullyCrashRenderer()
                window.webContents.reload()
                return true
              }
            }
            return false
          },
          kill: (pid) => process.kill(pid, "SIGKILL"),
          write: (line) => appendFileSync(telemetryFile, line, { mode: 0o600 }),
          rotate: () => rotateLogs(telemetryFile),
        }).start()
      }
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        // Gate on the requesting frame, not the top-level document: a cross-origin
        // iframe inside the local workspace page must not inherit its grants.
        callback(permissions.has(permission) && localNavigation(details?.requestingUrl || contents.getURL()))
      })
      // Registered before the first window loads, so a workspace page mounted
      // before any runtime was selected is already allowed to reach one.
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: relaxLoopbackConnectSrc(details.url, details.responseHeaders) })
      })
      if (app.isPackaged && process.platform === "darwin") {
        state.updateCache = path.join(app.getPath("userData"), "updates")
        mkdirSync(state.updateCache, { recursive: true, mode: 0o700 })
        // The helper can now identify and stop this exact process even if
        // startup fails before the sidecar or update service is ready.
        await acknowledgeUpdatePending()
      }
      applicationMenu()
      await updates()
      state.appearance = await readAppearance(appearanceFile())
      // No write is in flight yet, so anything still staged is from a kill.
      void sweepAppearance(appearanceFile())
      splash = new BrowserWindow({
        width: 520,
        height: 300,
        resizable: false,
        show: false,
        title: "OpenScience",
        backgroundColor: appearance().background,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      await splash.loadFile(splashPage, { query: splashQuery(appearance(), "start") })
      splash.show()
      if (await bootstrap(splash)) return
      if (process.platform === "win32") {
        app.setUserTasks([
          {
            program: process.execPath,
            arguments: "--new-window",
            iconPath: process.execPath,
            iconIndex: 0,
            title: "New Window",
            description: "Open another OpenScience workspace window",
          },
        ])
      }
      await start()
      await createWindow()
      // The first window is up; the previous session's runtime connection is
      // restored in the background so startup never waits on an SSH tunnel.
      void restoreRuntime()
      await acknowledgeUpdateHealth()
      splash.destroy()
    } catch (error) {
      if (state.updateRelaunch) {
        relaunchAfterExit(state.updateRelaunch)
        const timer = setTimeout(() => void stop(), 0)
        timer.unref?.()
        return
      }
      const safeBeforeRuntime =
        state.updateNoRuntime || state.updateRuntimeDisposed || state.runtimeLifecycle === "never_started"
      if (safeBeforeRuntime) {
        state.updateRuntimeDisposed = true
        state.runtimeLifecycle = "disposed"
      }
      const updateFailure = await acknowledgeUpdateFailure(error, safeBeforeRuntime).catch(() => undefined)
      if (updateFailure) {
        state.updateStartupFailure = error
        const recovered = await reconcileCurrentUpdate(false).catch(() => undefined)
        if (recovered?.relaunch) {
          state.updateRelaunch = recovered.relaunch
          relaunchAfterExit(recovered.relaunch)
        }
        // The helper waits for this exact PID, which remains alive until the
        // sidecar has fully drained, before it restores the previous bundle.
        const timer = setTimeout(() => void stop(), 0)
        timer.unref?.()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (!splash || splash.isDestroyed()) {
        dialog.showErrorBox("OpenScience could not start", message)
        app.exit(1)
        return
      }
      // Startup failures may carry a multi-line log tail; give it room and
      // keep its line breaks.
      splash.setResizable(true)
      splash.setSize(760, 560)
      splash.center()
      await splash.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<main style="font:16px system-ui;padding:48px"><h1>OpenScience could not start</h1><p style="font-size:13px;white-space:pre-wrap;word-break:break-word">${html(message)}</p></main>`)}`,
      )
    }
  })
  .catch((error) => {
    dialog.showErrorBox("OpenScience could not start", error instanceof Error ? error.message : String(error))
    app.exit(1)
  })

app.on("activate", () => {
  if (!windows.size) void createWindow()
})

// A System-scheme workspace repaints when the OS appearance flips; record the
// mode it moved to so the next launch opens on it rather than on the pair it
// last painted.
nativeTheme.on("updated", () => {
  for (const window of windows) void rememberAppearance(window)
})

app.on("before-quit", (event) => {
  // Tunnels must not outlive the app; the remote servers deliberately do.
  sshManager.stopAll()
  if (state.exiting) return
  event.preventDefault()
  void stop()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
