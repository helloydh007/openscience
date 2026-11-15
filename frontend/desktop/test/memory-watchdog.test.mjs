import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createMemoryWatchdog, decideActions, samplePidRss } from "../src/memory-watchdog.mjs"

// Electron metrics sizes are KB; the watchdog normalizes to MB and compares
// against a per-child threshold. The type strings below mirror what Electron
// reports at runtime.
const metrics = (rows) => rows.map(({ pid, type, mb }) => ({ pid, type, memory: { workingSetSize: mb * 1024 } }))

afterEach(() => {
  delete process.env.OPENSCIENCE_NO_MEMORY_WATCHDOG
})

describe("containment decisions", () => {
  test("a runaway gpu or utility child is killed outright", () => {
    const decisions = decideActions(
      [
        { pid: 11, type: "GPU", workingSetMb: 7_000 },
        { pid: 12, type: "Utility", workingSetMb: 6_500 },
      ],
      6_144,
    )
    expect(decisions).toEqual([
      { pid: 11, type: "GPU", action: "kill", workingSetMb: 7_000 },
      { pid: 12, type: "Utility", action: "kill", workingSetMb: 6_500 },
    ])
  })

  test("a flooded renderer is crashed and reloaded, not killed blind", () => {
    const decisions = decideActions([{ pid: 21, type: "Renderer", workingSetMb: 9_000 }], 6_144)
    expect(decisions).toEqual([{ pid: 21, type: "Renderer", action: "crash-reload", workingSetMb: 9_000 }])
  })

  test("browser, zygotes, sandbox helpers, and the sidecar are never killed", () => {
    const decisions = decideActions(
      [
        { pid: 1, type: "Browser", workingSetMb: 99_000 },
        { pid: 2, type: "Zygote", workingSetMb: 99_000 },
        { pid: 3, type: "Sandbox helper", workingSetMb: 99_000 },
        { pid: 4, type: "sidecar", workingSetMb: 99_000 },
      ],
      6_144,
    )
    expect(decisions).toEqual([])
  })

  test("children under the threshold and unknown shapes are ignored", () => {
    expect(decideActions([{ pid: 5, type: "GPU", workingSetMb: 6_143 }], 6_144)).toEqual([])
    expect(decideActions([{ pid: 6, type: "GPU" }], 6_144)).toEqual([])
    expect(decideActions([undefined, null], 6_144)).toEqual([])
    expect(decideActions([], 6_144)).toEqual([])
  })
})

describe("watchdog loop", () => {
  function setup({ metricRows = [], sidecar = null, rotateBytes = 1_000_000 } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mem-watchdog-"))
    const file = path.join(dir, "memory-watchdog.log")
    const killed = []
    const crashed = []
    let rotated = 0
    const watchdog = createMemoryWatchdog({
      metrics: () => metrics(metricRows),
      sidecarSample: () => sidecar,
      crashRenderer: (pid) => crashed.push(pid),
      kill: (pid) => killed.push(pid),
      write: (line) => appendFileSync(file, line),
      rotate: () => rotated++,
      intervalMs: 1_000_000, // tests call tick() by hand
      rotateBytes,
    })
    // The append path is a plain callback in production; mirror it here without
    // require() inside the injected closure.
    return { dir, file, killed, crashed, watchdog, rotated: () => rotated }
  }

  test("a tick kills an eligible child, crashes a flooded renderer, and writes telemetry", () => {
    const state = setup({
      metricRows: [
        { pid: 11, type: "GPU", mb: 7_000 },
        { pid: 21, type: "Renderer", mb: 9_000 },
        { pid: 1, type: "Browser", mb: 200 },
      ],
      sidecar: { pid: 4_000, rssMb: 300 },
    })
    state.watchdog.tick()
    expect(state.killed).toEqual([11])
    expect(state.crashed).toEqual([21])
    const lines = readFileSync(state.file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])
    expect(record.actions).toHaveLength(2)
    // The telemetry leads with the largest sample, sidecar included.
    expect(record.top[0].pid).toBe(21)
    expect(record.top.some((sample) => sample.type === "sidecar")).toBe(true)
    state.watchdog.stop()
  })

  test("a quiet tick writes telemetry and takes no action", () => {
    const state = setup({
      metricRows: [
        { pid: 1, type: "Browser", mb: 200 },
        { pid: 11, type: "GPU", mb: 300 },
      ],
    })
    state.watchdog.tick()
    expect(state.killed).toEqual([])
    expect(state.crashed).toEqual([])
    expect(readFileSync(state.file, "utf8")).toContain('"actions":[]')
    state.watchdog.stop()
  })

  test("telemetry rotates when the byte budget is exceeded", () => {
    const state = setup({ rotateBytes: 50 })
    state.watchdog.tick()
    state.watchdog.tick()
    expect(state.rotated()).toBeGreaterThanOrEqual(1)
    state.watchdog.stop()
  })

  test("stop ends sampling", () => {
    const state = setup()
    state.watchdog.stop()
    state.watchdog.tick()
    expect(readdirSync(state.dir)).toEqual([])
  })
})

describe("sidecar sampler", () => {
  test("reads VmRSS from /proc and reports null for missing pids", () => {
    const self = process.pid
    const rss = samplePidRss(self)
    expect(rss).toBeGreaterThan(0)
    expect(samplePidRss(0)).toBeNull()
    expect(samplePidRss(undefined)).toBeNull()
  })

  test("the sampler survives a pid owned by another user", () => {
    // pid 1 is readable but has no VmRSS for us in restrictive environments;
    // either outcome is fine as long as it does not throw.
    expect(() => samplePidRss(1)).not.toThrow()
  })
})
