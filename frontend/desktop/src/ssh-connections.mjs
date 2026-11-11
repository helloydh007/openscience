import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
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
// Bounds for ~/.ssh/config expansion: Include may nest and may use globs, so
// both the recursion depth and the number of files read are capped.
const SSH_CONFIG_MAX_DEPTH = 8
const SSH_CONFIG_MAX_FILES = 64
// Imported records are aliases, not copies of the settings they resolve to:
// ssh itself reads ~/.ssh/config, so a record only has to name the alias.
const SSH_CONFIG_ORIGIN = "ssh-config"

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
  // Imported aliases leave identity, port, and everything else to OpenSSH so
  // ProxyJump, Match blocks, and IdentitiesOnly keep their usual meaning.
  const imported = connection.origin === SSH_CONFIG_ORIGIN && Boolean(connection.alias)
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=15",
    ...(imported || !connection.port ? [] : ["-p", String(connection.port)]),
    ...(imported || !connection.identityFile ? [] : ["-i", connection.identityFile]),
  ]
}

export function sshTarget(connection) {
  // The alias goes to ssh verbatim: HostName, User, Port, IdentityFile, and
  // ProxyJump all come from the user's own ~/.ssh/config.
  if (connection.origin === SSH_CONFIG_ORIGIN && connection.alias) return connection.alias
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
 * Splits one ~/.ssh/config line into a keyword and its value. OpenSSH accepts
 * "Key value" and "Key=value", quoted values, and a trailing # comment, so
 * this mirrors those three rules and nothing more.
 */
function directive(line) {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*)$/.exec(line)
  if (!match) return undefined
  let value = ""
  let quote
  for (const char of match[2]) {
    if (quote) {
      if (char === quote) quote = undefined
      value += char
    } else if (char === '"' || char === "'") {
      quote = char
      value += char
    } else if (char === "#") {
      break
    } else {
      value += char
    }
  }
  value = value.trim()
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1)
  }
  return { key: match[1], value }
}

/**
 * Parses ssh_config text into the connectable aliases it declares.
 *
 * Wildcard and negated patterns describe defaults or exclusions, not a host
 * anyone can connect to, so they are skipped; Match blocks are skipped whole
 * because their conditions are OpenSSH's to evaluate, not ours. The first
 * value wins within a Host block, matching OpenSSH's own precedence.
 */
export function parseSshConfig(text) {
  const entries = []
  const declared = new Set()
  let block = []
  let inHost = false
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parsed = directive(line)
    if (!parsed) continue
    const key = parsed.key.toLowerCase()
    if (key === "host") {
      inHost = true
      block = []
      for (const pattern of parsed.value.split(/\s+/)) {
        if (!pattern || /[*?!]/.test(pattern)) continue
        // First declaration wins, exactly like OpenSSH's first-match rule.
        if (declared.has(pattern)) continue
        declared.add(pattern)
        const entry = { alias: pattern }
        entries.push(entry)
        block.push(entry)
      }
      continue
    }
    if (key === "match") {
      inHost = false
      block = []
      continue
    }
    if (!inHost) continue
    for (const entry of block) {
      if (key === "hostname" && entry.hostName === undefined) entry.hostName = parsed.value
      else if (key === "user" && entry.user === undefined) entry.user = parsed.value
      else if (key === "port" && entry.port === undefined) {
        const port = Number.parseInt(parsed.value, 10)
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) entry.port = port
      } else if (key === "identityfile" && entry.identityFile === undefined) {
        entry.identityFile = parsed.value
      }
    }
  }
  return entries
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function readdirSafe(directory) {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

/**
 * One glob segment: * and ? only, which is what ssh_config Include patterns
 * use in practice. Matching is per path segment so * never crosses a slash.
 */
function segmentMatcher(segment) {
  const source = segment
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char)))
    .join("")
  return new RegExp(`^${source}$`)
}

function walkGlob(segments, index, current, output, depth) {
  if (depth > SSH_CONFIG_MAX_DEPTH || output.length >= SSH_CONFIG_MAX_FILES) return
  if (index >= segments.length) {
    try {
      if (statSync(current).isFile()) output.push(current)
    } catch {}
    return
  }
  const segment = segments[index]
  if (segment === "**") {
    walkGlob(segments, index + 1, current, output, depth + 1)
    for (const name of readdirSafe(current)) {
      const next = path.join(current, name)
      try {
        if (statSync(next).isDirectory()) walkGlob(segments, index, next, output, depth + 1)
      } catch {}
    }
    return
  }
  if (!/[*?]/.test(segment)) {
    walkGlob(segments, index + 1, path.join(current, segment), output, depth)
    return
  }
  const matcher = segmentMatcher(segment)
  for (const name of readdirSafe(current)) {
    if (matcher.test(name)) walkGlob(segments, index + 1, path.join(current, name), output, depth)
  }
}

function expandGlob(pattern) {
  const output = []
  const absolute = pattern.startsWith("/")
  const segments = pattern.split("/").filter((segment) => segment.length > 0)
  walkGlob(segments, 0, absolute ? path.parse(pattern).root : ".", output, 0)
  return output.sort()
}

/**
 * Resolves an Include path the way OpenSSH does: "~" is the local home,
 * relative paths are relative to ~/.ssh, and the result may be a glob. "~user"
 * expansion is deliberately unsupported instead of guessed.
 */
function includeMatches(pattern, homeDir, sshDir) {
  let resolved
  if (pattern === "~") resolved = homeDir
  else if (pattern.startsWith("~/")) resolved = path.join(homeDir, pattern.slice(2))
  else if (pattern.startsWith("~")) return []
  else if (path.isAbsolute(pattern)) resolved = pattern
  else resolved = path.join(sshDir, pattern)
  return expandGlob(resolved)
}

function inlineIncludes(file, homeDir, sshDir, seen, depth) {
  if (depth > SSH_CONFIG_MAX_DEPTH || seen.size >= SSH_CONFIG_MAX_FILES) return ""
  let text
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return ""
  }
  const output = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      output.push(line)
      continue
    }
    const parsed = directive(trimmed)
    if (!parsed || parsed.key.toLowerCase() !== "include") {
      output.push(line)
      continue
    }
    for (const pattern of parsed.value.split(/\s+/)) {
      if (!pattern) continue
      for (const included of includeMatches(pattern, homeDir, sshDir)) {
        if (seen.has(included)) continue
        seen.add(included)
        output.push(inlineIncludes(included, homeDir, sshDir, seen, depth + 1))
      }
    }
  }
  return output.join("\n")
}

/**
 * Reads an ssh_config file with its Include directives expanded in place — the
 * same order OpenSSH processes them, so a Host block spanning an Include keeps
 * its context. A missing file is simply an empty config.
 */
export function readSshConfig(configPath, { homeDir = os.homedir() } = {}) {
  const seen = new Set([path.resolve(configPath)])
  const text = inlineIncludes(configPath, homeDir, path.dirname(configPath), seen, 0)
  return parseSshConfig(text)
}

/** The stored shape of an imported alias. Read-only in the UI: the file wins. */
export function configConnection(entry, prior) {
  return {
    id: `sshconfig:${entry.alias}`,
    label: entry.alias,
    host: entry.hostName ?? entry.alias,
    ...(entry.user ? { user: entry.user } : {}),
    ...(entry.port ? { port: entry.port } : {}),
    alias: entry.alias,
    origin: SSH_CONFIG_ORIGIN,
    remotePort: prior?.remotePort ?? 4096,
    // Derived records carry no real creation time; a stable 0 keeps the
    // merged list byte-identical across reads, so list() never writes.
    createdAt: prior?.createdAt ?? 0,
  }
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
 * Accepts an imported record as-is except for the one field the desktop still
 * owns: the remote port the server listens on. The alias is passed as a single
 * argv to ssh, so it only has to be free of whitespace and a leading hyphen.
 */
function resolveImported(stored) {
  if (typeof stored.alias !== "string" || !/^[A-Za-z0-9._+-]+$/.test(stored.alias) || stored.alias.startsWith("-"))
    throw new Error("The imported SSH alias is not safe to pass to ssh")
  if (typeof stored.label !== "string" || stored.label.length < 1 || stored.label.length > 120)
    throw new Error("The imported SSH alias has an invalid label")
  const remotePort = boundedPort(stored.remotePort, "remote port")
  if (remotePort === undefined) throw new Error("The remote port is required and must be 1 to 65535")
  return { ...stored, remotePort }
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
  // The user's own OpenSSH client configuration, parsed for aliases. Tests
  // point this at a fixture so the real ~/.ssh/config never leaks in.
  sshConfigPath = path.join(os.homedir(), ".ssh", "config"),
  homeDir = os.homedir(),
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
    return derived().all
  }

  /**
   * Manual records plus the aliases declared in ~/.ssh/config. The import is
   * derived on every read, so adding or removing a Host in the file shows up
   * without a restart. A manual record wins on the same label or the same
   * resolved endpoint, so importing can never shadow a connection the person
   * typed in by hand. Imported records are read-only: the file is the source
   * of truth and an edit here would be overwritten by the next import.
   */
  function derived() {
    const stored = load()
    const manual = stored.filter((connection) => connection.origin !== SSH_CONFIG_ORIGIN)
    const prior = new Map(
      stored
        .filter((connection) => connection.origin === SSH_CONFIG_ORIGIN)
        .map((connection) => [connection.id, connection]),
    )
    let entries = []
    try {
      entries = readSshConfig(sshConfigPath, { homeDir })
    } catch {}
    const labels = new Set(manual.map((connection) => connection.label.toLowerCase()))
    const endpoints = new Set(
      manual.map((connection) => `${connection.host}\u0000${connection.user ?? ""}\u0000${connection.port ?? ""}`),
    )
    const imported = []
    for (const entry of entries) {
      const record = configConnection(entry, prior.get(`sshconfig:${entry.alias}`))
      if (labels.has(record.label.toLowerCase())) continue
      const endpoint = `${record.host}\u0000${record.user ?? ""}\u0000${record.port ?? ""}`
      if (endpoints.has(endpoint)) continue
      imported.push(record)
    }
    return { manual, imported, all: [...manual, ...imported] }
  }

  /** Persists the current import; the dialog's Sync button calls this. */
  function sync() {
    const { all, imported } = derived()
    if (JSON.stringify(all) !== JSON.stringify(load())) persist(all)
    return { imported: imported.length, total: all.length }
  }

  function save(input) {
    if (typeof input?.id === "string" && input.id.startsWith("sshconfig:"))
      throw new Error("This SSH server comes from ~/.ssh/config; edit that file instead")
    const record = validateConnection(input)
    const connections = derived().all
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
    if (id.startsWith("sshconfig:")) throw new Error("This SSH server comes from ~/.ssh/config; edit that file instead")
    await disconnect(id)
    persist(derived().all.filter((connection) => connection.id !== id))
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

  // The sidecar this desktop ships is the local, telemetry-free build. Its
  // digest is part of the deploy decision so a remote that happens to carry
  // the same version string but different bytes (for example an upstream
  // release) is replaced rather than trusted.
  let localDigest
  async function sidecarDigest() {
    if (localDigest) return localDigest
    if (!existsSync(sidecarPath)) throw new Error(`The local OpenScience sidecar is missing: ${sidecarPath}`)
    const hash = createHash("sha256")
    await new Promise((resolve, reject) => {
      const stream = createReadStream(sidecarPath)
      stream.on("data", (chunk) => hash.update(chunk))
      stream.on("error", reject)
      stream.on("end", resolve)
    })
    localDigest = hash.digest("hex")
    return localDigest
  }

  /**
   * Deploys the desktop's own bundled sidecar when the remote BUILD marker
   * disagrees on version or digest — warm-stopping the previous server first —
   * then makes sure a server for this connection's remote port is listening.
   * An up-to-date remote never restarts or re-uploads anything. The binary is
   * always streamed from this desktop's own bundle: nothing is fetched from a
   * release server, so the remote runs the same local, telemetry-free build.
   */
  async function deploy(record) {
    const target = sshTarget(record)
    const base = sshBaseArgs(record)
    const digest = await sidecarDigest()
    await sshExec([...base, target, "true"], { timeoutMs: PROBE_TIMEOUT_MS, action: `Reaching ${target}` })
    await sshExec([...base, target, `mkdir -p ${REMOTE_ROOT}/bin ${REMOTE_ROOT}/staging`], {
      action: "Creating the remote OpenScience directories",
    })
    // BUILD holds "<version> <sha256> <origin>". VERSION is kept for readers
    // of the older layout; the deploy decision uses the digest, not just the
    // version string.
    const marker = (
      await sshExec([...base, target, `cat ${REMOTE_ROOT}/BUILD 2>/dev/null || true`], {
        action: "Reading the deployed OpenScience build",
      })
    ).trim()
    const [installedVersion, installedDigest] = marker.split(/\s+/)
    if (installedVersion !== version || installedDigest !== digest) {
      emit({
        connectionId: record.id,
        state: "uploading",
        message: `Deploying the bundled local OpenScience ${version} (no telemetry) to ${target}`,
      })
      await sshExec(
        [
          ...base,
          target,
          `if [ -f ${REMOTE_ROOT}/server.pid ]; then kill "$(cat ${REMOTE_ROOT}/server.pid)" 2>/dev/null || true; sleep 1; fi`,
        ],
        { action: "Stopping the previous remote OpenScience server" },
      )
      const staged = `${REMOTE_ROOT}/staging/openscience-${version}`
      await upload([...base, target, `cat > ${staged}`], sidecarPath, `Uploading OpenScience ${version} to ${target}`)
      await sshExec([...base, target, `mv ${staged} ${REMOTE_BIN} && chmod 755 ${REMOTE_BIN}`], {
        action: "Activating the uploaded OpenScience build",
      })
      // The remote bytes must be this desktop's bytes: a truncated or mangled
      // upload is caught here instead of failing later inside the server.
      const remoteDigest = (
        await sshExec([...base, target, `sha256sum ${REMOTE_BIN} 2>/dev/null | cut -d' ' -f1 || true`], {
          action: "Verifying the deployed OpenScience build",
        })
      ).trim()
      if (remoteDigest && remoteDigest !== digest)
        throw new Error(
          `The uploaded OpenScience binary does not match the local build (local ${digest}, remote ${remoteDigest})`,
        )
      await sshExec(
        [
          ...base,
          target,
          `printf '%s %s local-bundled\\n' ${shq(version)} ${shq(digest)} > ${REMOTE_ROOT}/BUILD && printf %s ${shq(version)} > ${REMOTE_ROOT}/VERSION`,
        ],
        { action: "Recording the deployed OpenScience build" },
      )
    }
    // A healthy port is not proof that this desktop owns the server behind it.
    // An older upstream build (or any other service) can hold the port, and
    // tunnelling to it would silently show that server's UI — including the
    // account login this fork removed. Identify the listener first.
    const server = await remoteServer(record, record.remotePort)
    if (server.healthy && server.ours && server.version === version) return record

    let effective = record
    if (server.listening && !server.ours) {
      // Leave a foreign listener untouched and serve this build from a free
      // port next to it; the chosen port is persisted so reconnects reuse it.
      const used = await remoteListeningPorts(record)
      const port = firstFreePort(record, used)
      if (port === undefined)
        throw new Error(
          `Remote port ${record.remotePort} on ${sshTarget(record)} is already in use by another service and no free port was found nearby`,
        )
      effective = adoptRemotePort(record, port)
      emit({
        connectionId: record.id,
        state: "uploading",
        message: `Port ${record.remotePort} on ${sshTarget(record)} is already used by ${
          server.version ? `another OpenScience (${server.version})` : "another service"
        }; using port ${port}`,
      })
    } else if (server.ours) {
      // Our own older build (or a half-started one) still holds the port but
      // does not match the desktop bundle; restart it in place so the freshly
      // deployed binary is the one that serves.
      await sshExec(
        [
          ...base,
          target,
          `if [ -f ${REMOTE_ROOT}/server.pid ]; then kill "$(cat ${REMOTE_ROOT}/server.pid)" 2>/dev/null || true; sleep 1; fi`,
        ],
        { action: "Stopping the previous remote OpenScience server" },
      )
    }
    // The deployed server gets its own data root under the deployment
    // directory. Besides isolating it from any other OpenScience install on
    // the host, this keeps it working when ~/.config is not writable by the
    // SSH user (common in containers, where ~/.config may be root-owned).
    const env = [
      `OPENSCIENCE_DATA_DIR=$HOME/.openscience/remote/data`,
      `XDG_CONFIG_HOME=$HOME/.openscience/remote/config`,
      `XDG_CACHE_HOME=$HOME/.openscience/remote/cache`,
      `XDG_DATA_HOME=$HOME/.openscience/remote/share`,
    ].join(" ")
    await sshExec(
      [
        ...base,
        target,
        `${env} setsid nohup ${REMOTE_BIN} serve --port ${effective.remotePort} >> ${REMOTE_ROOT}/server.log 2>&1 & echo $! > ${REMOTE_ROOT}/server.pid`,
      ],
      { action: "Starting the remote OpenScience server" },
    )
    if (!(await waitForOwnServer(effective))) {
      const tail = await remoteLogTail(effective)
      const cause = `The remote OpenScience server did not become healthy with the expected identity within ${Math.max(
        1,
        Math.round(HEALTH_DEADLINE_MS / 1000),
      )} seconds`
      throw new Error(tail ? `${cause}.\nRemote log tail:\n${tail}` : cause)
    }
    return effective
  }

  /**
   * Identifies the process listening on one remote loopback port: its resolved
   * executable and the health payload it serves. `ours` is the essential bit —
   * a truthy healthy flag alone says nothing about which build is answering.
   */
  async function remoteServer(record, port) {
    const command = [
      `pid=$( (ss -ltnpH "sport = :${port}" 2>/dev/null || ss -ltnp 2>/dev/null | grep -F ":${port} ") | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n1)`,
      `if [ -n "$pid" ]; then readlink -f /proc/$pid/exe 2>/dev/null || true; fi`,
      `curl -fsS --max-time 3 http://127.0.0.1:${port}/global/health 2>/dev/null || true`,
    ].join("; ")
    const result = await runProcess(sshExecutable, [...sshBaseArgs(record), sshTarget(record), command], {
      timeoutMs: 12_000,
    })
    if (result.code !== 0) return { listening: false, healthy: false, ours: false, version: undefined }
    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const exe = lines.find((line) => line.startsWith("/")) ?? ""
    const healthLine = lines.find((line) => line.startsWith("{")) ?? ""
    let health
    try {
      health = JSON.parse(healthLine)
    } catch {}
    const reported = typeof health?.version === "string" ? health.version : undefined
    const ours = exe
      ? exe.endsWith("/.openscience/remote/bin/openscience")
      : // No readable /proc: fall back to the version this desktop deployed.
        health?.healthy === true && reported === version
    return {
      listening: Boolean(exe) || health !== undefined,
      healthy: health?.healthy === true,
      ours,
      version: reported,
    }
  }

  /** Every TCP port currently listening on the remote, in one ssh round-trip. */
  async function remoteListeningPorts(record) {
    const command = `(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | sed -n 's/.*[.:]\\([0-9][0-9]*\\)[[:space:]].*/\\1/p' | sort -un | tr '\\n' ' '`
    const result = await runProcess(sshExecutable, [...sshBaseArgs(record), sshTarget(record), command], {
      timeoutMs: 12_000,
    })
    if (result.code !== 0) return new Set()
    return new Set(
      result.stdout
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65_535),
    )
  }

  function firstFreePort(record, used) {
    const limit = Math.min(65_535, record.remotePort + 40)
    for (let port = record.remotePort + 1; port <= limit; port++) {
      if (!used.has(port)) return port
    }
    return undefined
  }

  /** Persists the port the desktop fell back to, so reconnects keep using it. */
  function adoptRemotePort(record, port) {
    const connections = derived().all.map((connection) =>
      connection.id === record.id ? { ...connection, remotePort: port } : connection,
    )
    persist(connections)
    return connections.find((connection) => connection.id === record.id) ?? { ...record, remotePort: port }
  }

  /** Polls until the deployed binary itself answers health, not just any server. */
  async function waitForOwnServer(record) {
    const deadline = Date.now() + HEALTH_DEADLINE_MS
    while (Date.now() < deadline) {
      const server = await remoteServer(record, record.remotePort)
      if (server.healthy && server.ours) return true
      await pause(300)
    }
    return false
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
    const stored = derived().all.find((connection) => connection.id === id)
    if (!stored) return { ok: false, error: `No SSH connection has id ${id}` }
    if (active.has(id)) return { ok: false, error: `${stored.label} is already connecting or connected` }
    let record
    try {
      record = stored.origin === SSH_CONFIG_ORIGIN ? resolveImported(stored) : validateConnection(stored)
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
      // deploy() may move the server to a free remote port when the configured
      // one is occupied by a server this desktop did not deploy.
      session.connection = await deploy(record)
      if (!(await openTunnel(session))) {
        const tail = await remoteLogTail(session.connection)
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

  return { list, sync, save, remove, connect, disconnect, stopAll, onEvent }
}
