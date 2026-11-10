import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"

// Managed SSH connections for the desktop shell: stored records, remote
// sidecar deployment, a loopback-only tunnel, and the health gate the remote
// workspace window opens behind. Nothing here imports Electron; main.mjs
// supplies the user-data path, the sidecar binary and the app version, so the
// same state machine runs in tests against an injected fake ssh and probe.
// Disconnecting tears the tunnel down but leaves the remote server running by
// design: it is deployed to outlive the desktop session.
//
// Every ssh child is spawned from an argv array (never a shell string, never a
// password), every step carries a timeout, and every output capture is capped.
const PROBE_TIMEOUT_MS = 15_000
const COMMAND_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 600_000
const HEALTH_DEADLINE_MS = 20_000
const HEALTH_INTERVAL_MS = 250
const RECONNECT_DELAY_MS = 2_000
const RECONNECT_ATTEMPTS = 3
const OUTPUT_CAP = 65_536
// The fixed remote layout the deployed sidecar lives in.
const REMOTE_ROOT = "~/.openscience/remote"
const REMOTE_BIN = `${REMOTE_ROOT}/bin/openscience`

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wraps a value for safe interpolation into a remote shell command string. */
export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/**
 * The options every ssh invocation carries: batch mode so a missing key fails
 * instead of hanging on a prompt, a bounded connect, first-use host-key
 * acceptance, and keepalives so a dead route is noticed.
 */
export function sshBaseArgs(connection) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    ...(connection.port ? ["-p", String(connection.port)] : []),
    ...(connection.identityFile ? ["-i", connection.identityFile] : []),
  ]
}

export function sshTarget(connection) {
  return connection.user ? `${connection.user}@${connection.host}` : connection.host
}

/**
 * A bare forward with no remote command, bound to the local loopback only: the
 * remote service is reachable from this machine and nothing else.
 */
export function tunnelArgs(connection, localPort) {
  return [
    ...sshBaseArgs(connection),
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${connection.remotePort}`,
    sshTarget(connection),
  ]
}

function boundedPort(value, name) {
  if (value === undefined || value === null || value === "") return undefined
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`The ${name} must be 1 to 65535`)
  return value
}

/**
 * The stored record. Follows the spirit of the backend's SSH host schema
 * (backend/cli/src/compute/jobs.ts): a literal host, a POSIX-ish user, ports
 * in range, and an identity file that is one absolute line without shell
 * interpolation characters. Everything is trimmed; empty optional values are
 * dropped instead of stored.
 */
export function validateConnection(input) {
  if (!input || typeof input !== "object") throw new Error("An SSH connection record is required")
  const label = typeof input.label === "string" ? input.label.trim() : ""
  if (label.length < 1 || label.length > 120) throw new Error("The connection label must be 1 to 120 characters")
  const host = typeof input.host === "string" ? input.host.trim() : ""
  if (!/^[A-Za-z0-9._-]+$/.test(host) || host.startsWith("-")) {
    throw new Error(
      "The SSH host may only contain letters, digits, dots, underscores, and hyphens, and cannot begin with a hyphen",
    )
  }
  const user = typeof input.user === "string" && input.user.trim() ? input.user.trim() : undefined
  if (user !== undefined && !/^[a-z_][a-z0-9._-]*$/i.test(user)) {
    throw new Error(
      "The SSH user must start with a letter or underscore and contain only letters, digits, dots, underscores, and hyphens",
    )
  }
  const port = boundedPort(input.port, "port")
  const remotePort = boundedPort(input.remotePort, "remote port")
  if (remotePort === undefined) throw new Error("The remote port is required and must be 1 to 65535")
  const identityFile =
    typeof input.identityFile === "string" && input.identityFile.trim() ? input.identityFile.trim() : undefined
  if (identityFile !== undefined) {
    if (identityFile.length > 4_096) throw new Error("The SSH identity file path is too long")
    if (/[\u0000\r\n]/.test(identityFile)) throw new Error("The SSH identity file path must be a single line")
    if (/[%$]/.test(identityFile))
      throw new Error("The SSH identity file path must be literal and cannot contain % or $")
    if (!path.isAbsolute(identityFile) && !identityFile.startsWith("~/")) {
      throw new Error("The SSH identity file path must be absolute")
    }
  }
  return {
    id: typeof input.id === "string" && input.id ? input.id : randomUUID(),
    label,
    host,
    ...(user !== undefined && { user }),
    ...(port !== undefined && { port }),
    ...(identityFile !== undefined && { identityFile }),
    remotePort,
    createdAt: Date.now(),
  }
}

/**
 * One ssh invocation, always from an argv array, with a hard timeout (SIGTERM
 * on expiry) and bounded stdout/stderr capture. Settles on `close`, so exit
 * status and any captured output always arrive together.
 */
function runProcess(command, args, { timeoutMs, stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: stdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const bounded = (text, chunk) => (text.length < OUTPUT_CAP ? text + chunk.toString("utf8") : text)
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)
    timer.unref?.()
    child.stdin?.on("error", () => {})
    child.stdout?.on("data", (chunk) => {
      stdout = bounded(stdout, chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr = bounded(stderr, chunk)
    })
    let settled = false
    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, spawnError })
    }
    child.on("error", (error) => finish(undefined, undefined, error))
    child.on("close", (code, signal) => finish(code, signal))
    if (stdin) stdin.pipe(child.stdin)
  })
}

function execFailure(result, action) {
  if (result.spawnError) return `${action} failed: ${result.spawnError.message}`
  const reason = result.timedOut ? "timed out" : `exited with code ${result.code}`
  const detail = result.stderr.trim()
  return `${action} failed (${reason})${detail ? `: ${detail}` : ""}`
}

/**
 * A port the OS says is free. Closing before the tunnel binds is a small race;
 * a lost race surfaces as a tunnel start failure, and the reconnect machinery
 * picks a fresh port on its next attempt.
 */
async function freePort(attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const server = createServer()
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address()
          server.close(() => resolve(port))
        })
      })
    } catch (error) {
      if (attempt === attempts) throw error
    }
  }
}

/** The tunnel health gate: the workspace behind the local forward must answer. */
const defaultProbe = (url) =>
  fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false)

/** Polls until the probe passes, the deadline passes, or the session moves on. */
async function pollHealth(probe, url, isLive, deadlineMs, intervalMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (isLive() && (await probe(url))) return true
    await pause(intervalMs)
  }
  return false
}

/**
 * The connection manager: storage, the connect state machine, and the event
 * fan-out. One connect at a time per connection; an established tunnel that
 * dies on its own is re-established up to three times, while a deliberate
 * disconnect never retries.
 */
export function createSshManager({
  userData,
  sidecarPath,
  version,
  sshExecutable = "ssh",
  probe = defaultProbe,
  healthDeadlineMs = HEALTH_DEADLINE_MS,
  healthIntervalMs = HEALTH_INTERVAL_MS,
}) {
  if (!/^[\w.+-]+$/.test(String(version ?? "")))
    throw new Error("The desktop version is not safe for remote deployment")
  const file = path.join(userData, "ssh-connections.json")
  const listeners = new Set()
  // One entry per connection while a connect runs or a tunnel is up; the map
  // doubles as the one-connect-at-a-time gate.
  const active = new Map()
  let quitting = false

  function emit(event) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {}
    }
  }

  function load() {
    // ENOENT is the ordinary first-run state: nothing stored yet. Every other
    // failure (an unreadable file, invalid JSON, an unknown shape) is
    // corruption the records cannot be recovered from, so it also reads as
    // empty — which is safe only because persist() moves a store it cannot
    // read aside before overwriting it, so an empty read can never erase data.
    try {
      const stored = JSON.parse(readFileSync(file, "utf8"))
      if (stored?.version === 1 && Array.isArray(stored.connections)) return stored.connections
    } catch (error) {
      if (error?.code === "ENOENT") return []
    }
    return []
  }

  /**
   * Moves a store whose contents load() cannot interpret out of the way before
   * persist() overwrites it. A write interrupted mid-flight leaves truncated
   * JSON behind; overwriting that would silently delete every saved
   * connection. The original bytes are kept in a sibling file for manual
   * recovery, and a store that cannot be moved makes the save fail instead of
   * destroying what it could not preserve.
   */
  function preserveUnreadableStore() {
    let raw
    try {
      raw = readFileSync(file, "utf8")
    } catch (error) {
      if (error?.code === "ENOENT") return
      moveStoreAside("unreadable")
      return
    }
    try {
      const stored = JSON.parse(raw)
      if (stored?.version === 1 && Array.isArray(stored.connections)) return
    } catch {}
    moveStoreAside("corrupt")
  }

  function moveStoreAside(reason) {
    let target = `${file}.${reason}-${Date.now()}`
    let attempt = 0
    while (existsSync(target)) target = `${file}.${reason}-${Date.now()}-${++attempt}`
    renameSync(file, target)
  }

  function persist(connections) {
    mkdirSync(userData, { recursive: true })
    // Never let a write destroy content the records could not be read from.
    preserveUnreadableStore()
    // Owner-only: the file inventories hosts, users, and identity paths —
    // secrets-adjacent even though no credentials are ever stored.
    writeFileSync(file, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`, { mode: 0o600 })
  }

  function onEvent(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function list() {
    return load()
  }

  function save(input) {
    const record = validateConnection(input)
    const connections = load()
    const index = connections.findIndex((connection) => connection.id === record.id)
    if (index >= 0) {
      // An update keeps the original creation time; everything else is replaced.
      connections[index] = { ...record, createdAt: connections[index].createdAt }
    } else {
      connections.push(record)
    }
    persist(connections)
    return index >= 0 ? connections[index] : record
  }

  async function remove(id) {
    await disconnect(id)
    persist(load().filter((connection) => connection.id !== id))
  }

  async function sshExec(args, { timeoutMs = COMMAND_TIMEOUT_MS, action }) {
    const result = await runProcess(sshExecutable, args, { timeoutMs })
    if (result.code !== 0) throw new Error(execFailure(result, action))
    return result.stdout
  }

  async function upload(args, source, action) {
    const stream = createReadStream(source)
    const result = await runProcess(sshExecutable, args, { timeoutMs: UPLOAD_TIMEOUT_MS, stdin: stream })
    stream.destroy()
    if (result.code !== 0) throw new Error(execFailure(result, action))
  }

  /**
   * Deploys the desktop's own sidecar when the remote VERSION marker
   * disagrees — warm-stopping the previous server first — then makes sure a
   * server for this connection's remote port is listening. An up-to-date
   * remote never restarts anything.
   */
  async function deploy(record) {
    const target = sshTarget(record)
    const base = sshBaseArgs(record)
    await sshExec([...base, target, "true"], { timeoutMs: PROBE_TIMEOUT_MS, action: `Reaching ${target}` })
    await sshExec([...base, target, `mkdir -p ${REMOTE_ROOT}/bin ${REMOTE_ROOT}/staging`], {
      action: "Creating the remote OpenScience directories",
    })
    const installed = (
      await sshExec([...base, target, `cat ${REMOTE_ROOT}/VERSION 2>/dev/null || true`], {
        action: "Reading the deployed OpenScience version",
      })
    ).trim()
    if (installed !== version) {
      emit({ connectionId: record.id, state: "uploading", message: `Deploying OpenScience ${version} to ${target}` })
      await sshExec(
        [
          ...base,
          target,
          `if [ -f ${REMOTE_ROOT}/server.pid ]; then kill "$(cat ${REMOTE_ROOT}/server.pid)" 2>/dev/null || true; sleep 1; fi`,
        ],
        { action: "Stopping the previous remote OpenScience server" },
      )
      if (!existsSync(sidecarPath)) throw new Error(`The local OpenScience sidecar is missing: ${sidecarPath}`)
      const staged = `${REMOTE_ROOT}/staging/openscience-${version}`
      await upload([...base, target, `cat > ${staged}`], sidecarPath, `Uploading OpenScience ${version} to ${target}`)
      await sshExec(
        [
          ...base,
          target,
          `mv ${staged} ${REMOTE_BIN} && chmod 755 ${REMOTE_BIN} && printf %s ${shq(version)} > ${REMOTE_ROOT}/VERSION`,
        ],
        { action: "Activating the uploaded OpenScience build" },
      )
    }
    if (!(await remoteHealthy(record))) {
      await sshExec(
        [
          ...base,
          target,
          `setsid nohup ${REMOTE_BIN} serve --port ${record.remotePort} >> ${REMOTE_ROOT}/server.log 2>&1 & echo $! > ${REMOTE_ROOT}/server.pid`,
        ],
        { action: "Starting the remote OpenScience server" },
      )
    }
  }

  async function remoteHealthy(record) {
    const result = await runProcess(
      sshExecutable,
      [
        ...sshBaseArgs(record),
        sshTarget(record),
        `curl -fsS --max-time 3 http://127.0.0.1:${record.remotePort}/global/health >/dev/null 2>&1`,
      ],
      { timeoutMs: 10_000 },
    )
    return result.code === 0
  }

  async function remoteLogTail(record) {
    try {
      return (
        await sshExec(
          [...sshBaseArgs(record), sshTarget(record), `tail -c 2000 ${REMOTE_ROOT}/server.log 2>/dev/null || true`],
          { action: "Reading the remote OpenScience server log" },
        )
      ).trim()
    } catch {
      return ""
    }
  }

  /**
   * Spawns the loopback-only forward and waits for the remote workspace behind
   * it. Returns false when the health gate never passed or the session was
   * superseded; the caller decides what that means for its own flow.
   */
  async function openTunnel(session) {
    if (session.closing) return false
    const record = session.connection
    const generation = session.generation + 1
    session.generation = generation
    session.tunnelExit = undefined
    const localPort = await freePort()
    const tunnel = spawn(sshExecutable, tunnelArgs(record, localPort), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    tunnel.generation = generation
    session.tunnel = tunnel
    session.localPort = localPort
    session.url = `http://127.0.0.1:${localPort}`
    session.polling = true
    tunnel.on("close", (code, signal) => {
      if (tunnel.generation !== session.generation) return
      session.tunnelExit = signal ? `was terminated by ${signal}` : `exited with code ${code}`
      onTunnelClose(session)
    })
    const healthy = await pollHealth(
      probe,
      `${session.url}/global/health`,
      () => session.generation === generation && !session.closing && !session.tunnelExit,
      healthDeadlineMs,
      healthIntervalMs,
    )
    session.polling = false
    return healthy && !session.closing && !session.tunnelExit && session.generation === generation
  }

  /**
   * An established tunnel that dies on its own is re-established up to three
   * times; a deliberate disconnect, or a tunnel lost while its health gate is
   * still being polled (the connect flow owns that failure), never retries.
   */
  function onTunnelClose(session) {
    if (session.closing || session.polling) return
    if (session.attempts >= RECONNECT_ATTEMPTS) {
      void retire(session, "The SSH tunnel closed unexpectedly and could not be re-established")
      return
    }
    session.attempts += 1
    session.retryTimer = setTimeout(() => {
      session.retryTimer = undefined
      void retry(session)
    }, RECONNECT_DELAY_MS)
    session.retryTimer.unref?.()
  }

  async function retry(session) {
    if (session.closing) return
    try {
      if (!(await openTunnel(session))) throw new Error("The SSH tunnel could not be re-established")
      session.attempts = 0
      emit({ connectionId: session.connection.id, state: "tunnel-up", message: session.url })
    } catch (error) {
      await retire(session, error instanceof Error ? error.message : String(error))
    }
  }

  /** Ends a session for good: no retries, tunnel killed, failure reported. */
  async function retire(session, message) {
    const id = session.connection.id
    session.closing = true
    if (session.retryTimer) {
      clearTimeout(session.retryTimer)
      session.retryTimer = undefined
    }
    session.generation += 1
    await killTunnel(session.tunnel)
    if (active.get(id) === session) {
      active.delete(id)
      emit({ connectionId: id, state: "failed", message })
    }
  }

  /** SIGTERM with a SIGKILL backstop, so a wedged ssh cannot outlive the app. */
  function killTunnel(child) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
      child.kill("SIGTERM")
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 2_000)
      timer.unref?.()
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * The full connect flow: probe the host, deploy the sidecar if the remote
   * VERSION disagrees, start the remote server if it is not healthy, tunnel,
   * and health-gate the workspace URL. Resolves { ok, url } on success or
   * { ok: false, error }; every failure emits `failed`. When a confirm hook is
   * supplied it runs after `tunnel-up` — returning false tears the tunnel back
   * down and resolves { ok: false, error: "cancelled" }.
   */
  async function connect(id, { onTunnelUp } = {}) {
    if (quitting) return { ok: false, error: "OpenScience is quitting" }
    const stored = load().find((connection) => connection.id === id)
    if (!stored) return { ok: false, error: `No SSH connection has id ${id}` }
    if (active.has(id)) return { ok: false, error: `${stored.label} is already connecting or connected` }
    let record
    try {
      record = validateConnection(stored)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const session = {
      connection: record,
      closing: false,
      polling: false,
      attempts: 0,
      generation: 0,
      retryTimer: undefined,
      tunnel: undefined,
      tunnelExit: undefined,
      localPort: undefined,
      url: undefined,
    }
    active.set(id, session)
    try {
      emit({ connectionId: id, state: "connecting" })
      await deploy(record)
      if (!(await openTunnel(session))) {
        const tail = await remoteLogTail(record)
        const cause = session.tunnelExit
          ? `The SSH tunnel ${session.tunnelExit} before the remote server became healthy`
          : `The remote OpenScience server did not become healthy within ${Math.max(1, Math.round(healthDeadlineMs / 1000))} seconds`
        throw new Error(tail ? `${cause}.\nRemote log tail:\n${tail}` : cause)
      }
      emit({ connectionId: id, state: "tunnel-up", message: session.url })
      const proceed = onTunnelUp ? await onTunnelUp(session.url) : true
      if (!proceed) {
        await disconnect(id)
        return { ok: false, error: "cancelled" }
      }
      return { ok: true, url: session.url }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (active.get(id) === session) await retire(session, message)
      return { ok: false, error: message }
    }
  }

  /** Tears the tunnel down; the remote server keeps running by design. */
  async function disconnect(id) {
    const session = active.get(id)
    if (!session) {
      emit({ connectionId: id, state: "closed" })
      return
    }
    active.delete(id)
    session.closing = true
    if (session.retryTimer) {
      clearTimeout(session.retryTimer)
      session.retryTimer = undefined
    }
    session.generation += 1
    await killTunnel(session.tunnel)
    emit({ connectionId: id, state: "closed" })
  }

  /** Quit-time teardown: everything stops, nothing retries, nothing reports. */
  function stopAll() {
    quitting = true
    for (const session of [...active.values()]) {
      active.delete(session.connection.id)
      session.closing = true
      if (session.retryTimer) {
        clearTimeout(session.retryTimer)
        session.retryTimer = undefined
      }
      session.generation += 1
      void killTunnel(session.tunnel)
    }
  }

  return { list, save, remove, connect, disconnect, stopAll, onEvent }
}
