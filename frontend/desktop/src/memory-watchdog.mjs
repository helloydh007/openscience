import { readFileSync } from "node:fs"

// A per-process memory watchdog for the desktop shell. The 2026-11-15 OOM
// postmortem showed a single Chromium child reaching ~25 GB of anonymous
// memory while the system's swap was already exhausted: the freeze the person
// experiences is the whole machine thrashing, and the kernel then kills
// whichever child scores highest — with no record of what grew. This watchdog
// samples Electron's per-process metrics, writes a compact telemetry trail,
// and contains a runaway child before the system enters that spiral:
// gpu/utility children are killed (Chromium restarts both automatically), a
// flooded renderer is crashed and reloaded, and the browser, zygotes, and the
// sidecar are only observed — killing those costs real state.
//
// Nothing here imports Electron: main.mjs injects the metrics source, the
// kill/crash primitives, and the telemetry sink, so the decision logic runs
// unchanged in tests.

const NEVER_KILL = new Set(["browser", "zygote", "sandbox helper", "sandbox-helper", "sidecar"])

/**
 * One containment decision per runaway sample. workingSetMb is compared
 * against thresholdMb; browser, zygotes, sandbox helpers, and the sidecar are
 * never killed. Renderers crash-and-reload (their state is the page), every
 * other eligible child is killed outright (Chromium respawns gpu and network
 * services on its own).
 */
export function decideActions(entries, thresholdMb) {
  const actions = []
  for (const entry of entries) {
    if (typeof entry?.workingSetMb !== "number" || entry.workingSetMb < thresholdMb) continue
    const type = String(entry?.type ?? "").toLowerCase()
    if (NEVER_KILL.has(type)) continue
    actions.push({
      pid: entry.pid,
      type: entry.type,
      action: type === "renderer" ? "crash-reload" : "kill",
      workingSetMb: entry.workingSetMb,
    })
  }
  return actions
}

/** Reads one pid's resident set from /proc in MB; null when unreadable. */
export function samplePidRss(pid) {
  if (!pid) return null
  let text
  try {
    text = readFileSync(`/proc/${pid}/status`, "utf8")
  } catch {
    return null
  }
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text)
  if (!match) return null
  return Math.round((Number(match[1]) / 1024) * 10) / 10
}

/**
 * Starts the sampler. metrics() returns Electron's app.getAppMetrics() array
 * (memory sizes are KB); sidecarSample() returns { pid, rssMb } | null for the
 * spawn child Electron tracks outside its own metrics. crashRenderer(pid)
 * finds the window owning that renderer and crashes+reloads it, returning
 * whether it handled the pid. kill(pid) SIGKILLs an eligible child. write(line)
 * appends telemetry and rotate() moves the telemetry file aside when the byte
 * budget is exceeded. Returns { stop }.
 */
export function createMemoryWatchdog({
  metrics,
  sidecarSample,
  crashRenderer,
  kill,
  write,
  rotate,
  intervalMs = 10_000,
  thresholdMb = 6_144,
  rotateBytes = 512 * 1024,
}) {
  let timer
  let bytes = 0
  let stopped = false

  function tick() {
    if (stopped) return
    let entries
    try {
      entries = collectSamples(metrics, sidecarSample)
    } catch {
      return
    }
    const actions = decideActions(entries, thresholdMb)
    for (const decision of actions) {
      try {
        if (decision.action === "crash-reload") crashRenderer?.(decision.pid)
        else kill?.(decision.pid)
      } catch {}
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), top: topSamples(entries), actions })
    try {
      write(`${line}\n`)
      bytes += line.length + 1
      if (bytes > rotateBytes) {
        bytes = 0
        rotate?.()
      }
    } catch {}
  }

  function start() {
    if (stopped) return
    tick()
    timer = setInterval(tick, intervalMs)
    timer.unref?.()
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
  }

  return { start, stop, tick }
}

function collectSamples(metrics, sidecarSample) {
  const entries = []
  for (const metric of metrics() ?? []) {
    const workingSetMb = Math.round(((metric?.memory?.workingSetSize ?? 0) / 1024) * 10) / 10
    entries.push({ pid: metric?.pid, type: String(metric?.type ?? "unknown"), workingSetMb })
  }
  const sidecar = sidecarSample?.()
  if (sidecar && typeof sidecar.rssMb === "number") {
    entries.push({ pid: sidecar.pid, type: "sidecar", workingSetMb: sidecar.rssMb })
  }
  return entries
}

function topSamples(entries) {
  return [...entries].sort((a, b) => b.workingSetMb - a.workingSetMb).slice(0, 5)
}
