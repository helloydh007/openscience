import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createSshManager,
  parseSshConfig,
  readSshConfig,
  shq,
  sshBaseArgs,
  sshTarget,
  tunnelArgs,
  validateConnection,
} from "../src/ssh-connections.mjs"

// The fake ssh answers every remote command the state machine runs and records
// each invocation in a log the tests read back. The tunnel (recognized by its
// ExitOnForwardFailure option) stays alive on `exec sleep` until the manager
// kills it, so the happy path never trips the reconnect machinery. Extension
// sync commands (tar -C … -xf -) are executed for real: stdin is written to a
// temp file, the `-xf -` in the remote command is swapped for that file, and
// the whole command is evaluated as written — with $HOME pinned to the fixture
// root — so synced fixtures really land in the fake remote tree, including the
// staging swap the replace item performs.
const fakeSshScript = `#!/usr/bin/env bash
log="\${FAKE_SSH_LOG}"
# The remote layout is anchored at the SSH user's home, so the fake remote
# pins $HOME to the fixture root before evaluating any remote command.
if [ -n "\${FAKE_SSH_HOME:-}" ]; then export HOME="\${FAKE_SSH_HOME}"; fi
all="$*"
cmd="\${*: -1}"
if [[ "$all" == *"ExitOnForwardFailure"* ]]; then
  printf '%s\\n' "tunnel: $all" >> "$log"
  exec sleep 120
fi
printf '%s\\n' "cmd: $cmd" >> "$log"
case "$cmd" in
  "true") exit \${FAKE_SSH_PROBE_EXIT:-0} ;;
  "cat ~/.openscience/remote/VERSION"*)
    if [ -n "\${FAKE_SSH_VERSION:-}" ]; then printf '%s' "\${FAKE_SSH_VERSION}"; fi
    exit 0
    ;;
  "cat ~/.openscience/remote/BUILD"*)
    if [ -n "\${FAKE_SSH_BUILD:-}" ]; then printf '%s' "\${FAKE_SSH_BUILD}"; fi
    exit 0
    ;;
  sha256sum*)
    if [ -n "\${FAKE_SSH_DIGEST:-}" ]; then printf '%s\\n' "\${FAKE_SSH_DIGEST}"; fi
    exit 0
    ;;
  *"setsid nohup "*)
    port=\$(printf '%s' "$cmd" | sed -n 's/.*--port \\([0-9][0-9]*\\).*/\\1/p')
    printf '%s' "$port" > "\${FAKE_SSH_STATE}"
    exit 0
    ;;
  "pid="*)
    port=\$(printf '%s' "$cmd" | sed -n 's/.*sport = :\\([0-9][0-9]*\\).*/\\1/p')
    running=\$(cat "\${FAKE_SSH_STATE}" 2>/dev/null || true)
    if [ -n "$running" ] && [ "$running" = "$port" ]; then
      printf '%s\\n' "\${FAKE_SSH_EXE:-/home/dev/.openscience/remote/bin/openscience}"
      printf '{"healthy":true,"version":"%s"}\\n' "\${FAKE_SSH_OURS_VERSION:-9.9.9}"
    elif [ -n "\${FAKE_SSH_FOREIGN:-}" ] && [ "$port" = "\${FAKE_SSH_FOREIGN_PORT:-4096}" ]; then
      printf '%s\\n' "/workspace/runtime/node_modules/@synsci/openscience-linux-x64/bin/openscience"
      printf '{"healthy":true,"version":"%s"}\\n' "\${FAKE_SSH_FOREIGN}"
    fi
    exit 0
    ;;
  "(ss -ltnH"*)
    printf '%s' "\${FAKE_SSH_LISTEN:-}"
    exit 0
    ;;
  "rm -rf "*|*"tar -C "*)
    if [ -n "\${FAKE_SSH_SYNC_EXIT:-}" ]; then exit "\${FAKE_SSH_SYNC_EXIT}"; fi
    if [[ "$cmd" == *" -xf -"* ]]; then
      tmpfile="\$(mktemp "\${TMPDIR:-/tmp}/fake-ssh-sync.XXXXXX")"
      cat > "$tmpfile"
      archive="$tmpfile"
      # A failing replace item exercises the staging swap: the archive is
      # unreadable, so tar fails after staging and the real destination must
      # survive untouched.
      if [ -n "\${FAKE_SSH_REPLACE_TAR_EXIT:-}" ] && [[ "$cmd" == *".sync-staging"* ]]; then
        archive="/nonexistent/fake-ssh-missing-archive.tar"
      fi
      # The command is evaluated as written, with only the tar stream swapped
      # for the captured stdin, so the manager's quoting and the $HOME
      # anchoring are exercised exactly as a real remote shell would.
      eval "\${cmd/ -xf -/ -xf '$archive'}"
      rc=\$?
      rm -f "$tmpfile"
      if [ \$rc -eq 0 ]; then printf '%s\\n' "sync: $cmd" >> "$log"; fi
      exit \$rc
    fi
    exit 0
    ;;
  "cat > "*) bytes=\$(wc -c); printf '%s\\n' "upload: $bytes" >> "$log"; exit 0 ;;
  curl*) exit 1 ;;
  tail*) printf 'FATAL: listen tcp 127.0.0.1:4096: bind: address already in use\\n' ;;
  *) exit 0 ;;
esac
`

const SIDECAR_BYTES = 4096
let root
const cleanups = []

function setup({ probe, healthDeadlineMs = 1_000, sshConfig } = {}) {
  const dir = mkdtempSync(path.join(root, "run-"))
  const script = path.join(dir, "fake-ssh")
  writeFileSync(script, fakeSshScript)
  chmodSync(script, 0o755)
  const sidecar = path.join(dir, "openscience")
  writeFileSync(sidecar, Buffer.alloc(SIDECAR_BYTES, 1))
  const digest = createHash("sha256").update(readFileSync(sidecar)).digest("hex")
  const sshConfigPath = path.join(dir, "ssh-config")
  if (sshConfig !== undefined) writeFileSync(sshConfigPath, sshConfig)
  process.env.FAKE_SSH_LOG = path.join(dir, "fake-ssh.log")
  process.env.FAKE_SSH_STATE = path.join(dir, "fake-ssh-state")
  process.env.FAKE_SSH_DIGEST = digest
  // The fake remote's home is the fixture root, so remote commands anchored at
  // $HOME unpack inside the same tree the assertions read back.
  process.env.FAKE_SSH_HOME = dir
  delete process.env.FAKE_SSH_PROBE_EXIT
  delete process.env.FAKE_SSH_VERSION
  delete process.env.FAKE_SSH_BUILD
  delete process.env.FAKE_SSH_FOREIGN
  delete process.env.FAKE_SSH_FOREIGN_PORT
  delete process.env.FAKE_SSH_LISTEN
  delete process.env.FAKE_SSH_SYNC_EXIT
  delete process.env.FAKE_SSH_REPLACE_TAR_EXIT
  const manager = createSshManager({
    userData: dir,
    sidecarPath: sidecar,
    version: "9.9.9",
    sshExecutable: script,
    probe: probe ?? (async () => true),
    healthDeadlineMs,
    healthIntervalMs: 25,
    sshConfigPath,
    homeDir: dir,
  })
  cleanups.push(() => {
    manager.stopAll()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir,
    manager,
    digest,
    log: () => readFileSync(process.env.FAKE_SSH_LOG, "utf8"),
    // Exposed so a test can build a second manager over the same store.
    sshPath: script,
    sidecarPath: sidecar,
  }
}

// The tunnel child logs its invocation a few milliseconds after the connect
// promise resolves, so the tests wait for a line instead of racing it.
async function waitForLog(log, fragment, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (log().includes(fragment)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`The fake ssh log never contained ${JSON.stringify(fragment)}`)
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ssh-connections-test-"))
})

afterEach(() => {
  while (cleanups.length) cleanups.pop()()
  delete process.env.FAKE_SSH_LOG
  delete process.env.FAKE_SSH_STATE
  delete process.env.FAKE_SSH_PROBE_EXIT
  delete process.env.FAKE_SSH_VERSION
  delete process.env.FAKE_SSH_BUILD
  delete process.env.FAKE_SSH_DIGEST
  delete process.env.FAKE_SSH_HOME
  delete process.env.FAKE_SSH_FOREIGN
  delete process.env.FAKE_SSH_FOREIGN_PORT
  delete process.env.FAKE_SSH_LISTEN
  delete process.env.FAKE_SSH_SYNC_EXIT
  delete process.env.FAKE_SSH_REPLACE_TAR_EXIT
})

describe("connection validation", () => {
  const valid = { label: "Lab", host: "lab.example.com", remotePort: 4096 }

  test("accepts a minimal record and generates an id and creation time", () => {
    const record = validateConnection(valid)
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(record.label).toBe("Lab")
    expect(record.host).toBe("lab.example.com")
    expect(record.remotePort).toBe(4096)
    expect(record.createdAt).toBeGreaterThan(0)
    expect("user" in record).toBe(false)
    expect("port" in record).toBe(false)
    expect("identityFile" in record).toBe(false)
  })

  test("keeps a caller-supplied id and optional fields", () => {
    const record = validateConnection({
      ...valid,
      id: "fixed-id",
      user: "Sci_1.ops-2",
      port: 2222,
      identityFile: "/home/u/key",
    })
    expect(record.id).toBe("fixed-id")
    expect(record.user).toBe("Sci_1.ops-2")
    expect(record.port).toBe(2222)
    expect(record.identityFile).toBe("/home/u/key")
  })

  test("rejects labels outside 1-120 characters", () => {
    expect(() => validateConnection({ ...valid, label: "" })).toThrow()
    expect(() => validateConnection({ ...valid, label: "   " })).toThrow()
    expect(() => validateConnection({ ...valid, label: "x".repeat(121) })).toThrow()
    expect(validateConnection({ ...valid, label: "x".repeat(120) }).label.length).toBe(120)
  })

  test("rejects hosts that are not literal names or begin with a hyphen", () => {
    for (const host of ["", "exa mple", "-lab", "lab/x", "lab:22", "la\tb"]) {
      expect(() => validateConnection({ ...valid, host })).toThrow()
    }
    for (const host of ["lab.example.com", "10.0.0.5", "my_host-1", "HOST"]) {
      expect(() => validateConnection({ ...valid, host })).not.toThrow()
    }
  })

  test("rejects users that are not POSIX-ish names", () => {
    expect(() => validateConnection({ ...valid, user: "9abc" })).toThrow()
    expect(() => validateConnection({ ...valid, user: "a b" })).toThrow()
    expect(() => validateConnection({ ...valid, user: "a@b" })).toThrow()
    expect(() => validateConnection({ ...valid, user: "-a" })).toThrow()
    expect(validateConnection({ ...valid, user: "_ops-1" }).user).toBe("_ops-1")
  })

  test("requires a remote port in range and bounds the ssh port", () => {
    expect(() => validateConnection({ label: "Lab", host: "lab.example.com" })).toThrow()
    expect(() => validateConnection({ ...valid, remotePort: 0 })).toThrow()
    expect(() => validateConnection({ ...valid, remotePort: 65_536 })).toThrow()
    expect(() => validateConnection({ ...valid, remotePort: 1.5 })).toThrow()
    expect(validateConnection({ ...valid, remotePort: 65_535 }).remotePort).toBe(65_535)
    expect(() => validateConnection({ ...valid, port: 0 })).toThrow()
    expect(() => validateConnection({ ...valid, port: 65_535 })).not.toThrow()
  })

  test("rejects identity files that are relative, multi-line, or interpolated", () => {
    expect(() => validateConnection({ ...valid, identityFile: "relative/key" })).toThrow()
    expect(() => validateConnection({ ...valid, identityFile: "/ok\nnewline" })).toThrow()
    expect(() => validateConnection({ ...valid, identityFile: "/ok%var" })).toThrow()
    expect(() => validateConnection({ ...valid, identityFile: "/ok$dollar" })).toThrow()
    expect(validateConnection({ ...valid, identityFile: "/home/u/key" }).identityFile).toBe("/home/u/key")
    expect(validateConnection({ ...valid, identityFile: "~/keys/id" }).identityFile).toBe("~/keys/id")
  })

  test("requires a record object", () => {
    expect(() => validateConnection(undefined)).toThrow()
    expect(() => validateConnection("lab")).toThrow()
  })
})

describe("ssh argument builders", () => {
  const connection = {
    id: "id",
    label: "Lab",
    host: "lab.example.com",
    user: "sci",
    port: 2222,
    identityFile: "/home/u/key",
    remotePort: 4096,
    createdAt: 1,
  }

  test("sshBaseArgs emits the fixed options plus the per-host ones", () => {
    expect(sshBaseArgs(connection)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      "-p",
      "2222",
      "-i",
      "/home/u/key",
    ])
    expect(sshBaseArgs({ ...connection, port: undefined, identityFile: undefined })).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
    ])
  })

  test("sshTarget joins the user only when present", () => {
    expect(sshTarget(connection)).toBe("sci@lab.example.com")
    expect(sshTarget({ ...connection, user: undefined })).toBe("lab.example.com")
  })

  test("an imported alias is passed to ssh verbatim, without -p or -i", () => {
    const imported = {
      ...connection,
      origin: "ssh-config",
      alias: "lab",
      host: "lab.example.com",
    }
    // OpenSSH resolves HostName/User/Port/IdentityFile from ~/.ssh/config, so
    // the desktop must not override any of them.
    expect(sshTarget(imported)).toBe("lab")
    expect(sshBaseArgs(imported)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
    ])
  })

  test("tunnelArgs forwards the remote loopback onto the local loopback only", () => {
    expect(tunnelArgs(connection, 53_123)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      "-p",
      "2222",
      "-i",
      "/home/u/key",
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "127.0.0.1:53123:127.0.0.1:4096",
      "sci@lab.example.com",
    ])
  })

  test("shq single-quotes values and escapes embedded quotes", () => {
    expect(shq("9.9.9")).toBe("'9.9.9'")
    expect(shq("it's")).toBe("'it'\\''s'")
    expect(shq("")).toBe("''")
  })
})

describe("~/.ssh/config import", () => {
  test("parses aliases with their host settings and first value wins", () => {
    const entries = parseSshConfig(`
# comment
Host lab gpu
  HostName 10.0.0.9
  HostName ignored.example.com
  User Sci
  Port 2222
  IdentityFile "~/keys/id ed25519"

Host=dev
  HostName=dev.example.com
  User=root
`)
    expect(entries).toEqual([
      { alias: "lab", hostName: "10.0.0.9", user: "Sci", port: 2222, identityFile: "~/keys/id ed25519" },
      { alias: "gpu", hostName: "10.0.0.9", user: "Sci", port: 2222, identityFile: "~/keys/id ed25519" },
      { alias: "dev", hostName: "dev.example.com", user: "root" },
    ])
  })

  test("skips wildcard and negated patterns and Match blocks", () => {
    const entries = parseSshConfig(`
Host *
  User everyone
  Port 2200
Host !internal *.corp.example.com
  User wildcard
Host real
  HostName real.example.com
Match host real user root
  Port 9
Host last
  HostName last.example.com
`)
    expect(entries.map((entry) => entry.alias)).toEqual(["real", "last"])
    // Global defaults are not copied onto real hosts; ssh applies them itself.
    expect(entries[0]).toEqual({ alias: "real", hostName: "real.example.com" })
    expect(entries[1]).toEqual({ alias: "last", hostName: "last.example.com" })
  })

  test("expands Include in place, including globs and ~", () => {
    const dir = mkdtempSync(path.join(root, "config-"))
    try {
      mkdirSync(path.join(dir, "conf.d"))
      writeFileSync(
        path.join(dir, "config"),
        `Host one\n  HostName one.example.com\nInclude extra.conf\nInclude conf.d/*.conf\nInclude ~/home.conf\nHost two\n  HostName two.example.com\n`,
      )
      writeFileSync(path.join(dir, "extra.conf"), `Host included\n  HostName included.example.com\n`)
      writeFileSync(path.join(dir, "conf.d", "a.conf"), `Host globbed\n  HostName globbed.example.com\n`)
      writeFileSync(path.join(dir, "home.conf"), `Host homed\n  HostName homed.example.com\n`)
      const entries = readSshConfig(path.join(dir, "config"), { homeDir: dir })
      expect(entries.map((entry) => entry.alias)).toEqual(["one", "included", "globbed", "homed", "two"])
      expect(entries[2].hostName).toBe("globbed.example.com")
      expect(entries[3].hostName).toBe("homed.example.com")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing config file imports nothing", () => {
    expect(readSshConfig(path.join(root, "missing", "config"), { homeDir: root })).toEqual([])
  })

  test("the list carries imported aliases after the manual records", () => {
    const { manager } = setup({
      sshConfig: `Host lab\n  HostName 10.0.0.9\n  User sci\n  Port 2222\n`,
    })
    const manual = manager.save({ label: "Mine", host: "mine.example.com", remotePort: 4096 })
    const list = manager.list()
    expect(list.map((connection) => connection.label)).toEqual(["Mine", "lab"])
    expect(list[0].id).toBe(manual.id)
    expect(list[1]).toMatchObject({
      id: "sshconfig:lab",
      label: "lab",
      host: "10.0.0.9",
      user: "sci",
      port: 2222,
      alias: "lab",
      origin: "ssh-config",
      remotePort: 4096,
    })
  })

  test("a manual record with the same label wins over the import", () => {
    const { manager } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n` })
    manager.save({ label: "lab", host: "typed.example.com", remotePort: 4096 })
    const list = manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].host).toBe("typed.example.com")
    expect(list[0].origin).toBeUndefined()
  })

  test("imported records are read-only", async () => {
    const { manager } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n` })
    const imported = manager.list()[0]
    expect(() => manager.save({ ...imported, label: "renamed" })).toThrow(/ssh\/config/)
    await expect(manager.remove(imported.id)).rejects.toThrow(/ssh\/config/)
  })

  test("editing ~/.ssh/config is reflected on the next list", () => {
    const { manager, dir } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n` })
    expect(manager.list().map((connection) => connection.label)).toEqual(["lab"])
    writeFileSync(path.join(dir, "ssh-config"), `Host lab\n  HostName 10.0.0.9\nHost newer\n  HostName 10.0.0.10\n`)
    expect(manager.list().map((connection) => connection.label)).toEqual(["lab", "newer"])
    writeFileSync(path.join(dir, "ssh-config"), `Host newer\n  HostName 10.0.0.10\n`)
    expect(manager.list().map((connection) => connection.label)).toEqual(["newer"])
    expect(manager.sync()).toEqual({ imported: 1, total: 1 })
  })

  test("an imported alias connects through the alias, not a rebuilt user@host", async () => {
    const { manager, log } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n  User sci\n  Port 2222\n` })
    const imported = manager.list()[0]
    const result = await manager.connect(imported.id)
    expect(result.ok).toBe(true)
    await waitForLog(log, "tunnel:")
    const text = log()
    // The tunnel target is the alias (first whitespace-delimited token after
    // the forward), and the per-host -p/-i overrides are absent.
    expect(text).toMatch(/tunnel: .* lab\n/)
    expect(text).not.toContain("sci@10.0.0.9")
    expect(text).not.toContain("-p 2222")
    expect(text).not.toContain("-i ")
    await manager.disconnect(imported.id)
  })
})

describe("connection storage", () => {
  test("saves with the documented file shape and owner-only permissions", () => {
    const { dir, manager } = setup()
    manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const file = path.join(dir, "ssh-connections.json")
    const stored = JSON.parse(readFileSync(file, "utf8"))
    expect(stored.version).toBe(1)
    expect(stored.connections).toHaveLength(1)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })

  test("an update with an id replaces the record and keeps its creation time", () => {
    const { dir, manager } = setup()
    const first = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const updated = manager.save({ ...first, label: "Lab renamed", host: "other.example.com" })
    expect(updated.createdAt).toBe(first.createdAt)
    expect(updated.label).toBe("Lab renamed")
    const stored = JSON.parse(readFileSync(path.join(dir, "ssh-connections.json"), "utf8"))
    expect(stored.connections).toHaveLength(1)
    expect(stored.connections[0].label).toBe("Lab renamed")
  })

  test("remove stops the tunnel if one is up and deletes the record", async () => {
    const { manager, log } = setup()
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const events = []
    manager.onEvent((event) => events.push(event))
    expect((await manager.connect(saved.id)).ok).toBe(true)
    await waitForLog(log, "tunnel:")
    await manager.remove(saved.id)
    expect(manager.list()).toEqual([])
    expect(events.at(-1)?.state).toBe("closed")
    expect(log()).toContain("tunnel:")
    const again = await manager.connect(saved.id)
    expect(again.ok).toBe(false)
  })

  test("a corrupted store is preserved instead of silently wiped by the next save", () => {
    const { dir, manager } = setup()
    const file = path.join(dir, "ssh-connections.json")
    manager.save({ label: "Alpha", host: "alpha.example.com", remotePort: 4096 })
    manager.save({ label: "Beta", host: "beta.example.com", remotePort: 4096 })
    // A write interrupted mid-flight leaves truncated JSON behind.
    writeFileSync(file, `{"version":1,"connections":[{"id":"x","lab`)
    expect(manager.list()).toEqual([])
    manager.save({ label: "Gamma", host: "gamma.example.com", remotePort: 4096 })
    expect(manager.list().map((connection) => connection.label)).toEqual(["Gamma"])
    // The corrupt bytes were moved aside intact, so the old records survive
    // for manual recovery even though they cannot be parsed.
    const backups = readdirSync(dir).filter((name) => name.startsWith("ssh-connections.json.corrupt-"))
    expect(backups).toHaveLength(1)
    const corrupt = `{"version":1,"connections":[{"id":"x","lab`
    expect(readFileSync(path.join(dir, backups[0]), "utf8")).toBe(corrupt)
    expect(JSON.parse(readFileSync(path.join(dir, "ssh-connections.json"), "utf8")).connections).toHaveLength(1)
  })

  test("a store with an unknown shape is preserved too", () => {
    const { dir, manager } = setup()
    const file = path.join(dir, "ssh-connections.json")
    manager.save({ label: "Alpha", host: "alpha.example.com", remotePort: 4096 })
    writeFileSync(file, `{"version":2,"connections":"not-a-list"}`)
    manager.save({ label: "Gamma", host: "gamma.example.com", remotePort: 4096 })
    expect(manager.list().map((connection) => connection.label)).toEqual(["Gamma"])
    const backups = readdirSync(dir).filter((name) => name.startsWith("ssh-connections.json.corrupt-"))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(readFileSync(path.join(dir, backups[0]), "utf8"))).toEqual({
      version: 2,
      connections: "not-a-list",
    })
  })

  test("an unreadable store is preserved rather than truncated by the next save", () => {
    const { dir, manager } = setup()
    const file = path.join(dir, "ssh-connections.json")
    manager.save({ label: "Alpha", host: "alpha.example.com", remotePort: 4096 })
    chmodSync(file, 0o000)
    manager.save({ label: "Gamma", host: "gamma.example.com", remotePort: 4096 })
    expect(manager.list().map((connection) => connection.label)).toEqual(["Gamma"])
    const backups = readdirSync(dir).filter((name) => name.startsWith("ssh-connections.json.unreadable-"))
    expect(backups).toHaveLength(1)
    const preserved = path.join(dir, backups[0])
    chmodSync(preserved, 0o600)
    expect(JSON.parse(readFileSync(preserved, "utf8")).connections.map((c) => c.label)).toEqual(["Alpha"])
  })

  test("a healthy store is never moved aside on save", () => {
    const { dir, manager } = setup()
    manager.save({ label: "Alpha", host: "alpha.example.com", remotePort: 4096 })
    manager.save({ label: "Beta", host: "beta.example.com", remotePort: 4096 })
    expect(manager.list().map((connection) => connection.label)).toEqual(["Alpha", "Beta"])
    expect(readdirSync(dir).filter((name) => name.startsWith("ssh-connections.json."))).toEqual([])
  })
})

describe("connect state machine", () => {
  test("a missing id reports an error", async () => {
    const { manager } = setup()
    expect(await manager.connect("nope")).toEqual({ ok: false, error: "No SSH connection has id nope" })
  })

  test("onEvent returns an unsubscribe function", async () => {
    const { manager } = setup()
    const events = []
    const off = manager.onEvent((event) => events.push(event))
    off()
    await manager.disconnect("missing")
    expect(events).toEqual([])
  })

  test("connect deploys the sidecar, starts the remote server, and brings the tunnel up", async () => {
    const { manager, log } = setup()
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({
      label: "Lab",
      host: "lab.example.com",
      user: "sci",
      port: 2222,
      remotePort: 4096,
    })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // The sync phase always runs after deploy (whose own upload event precedes
    // it) and before the tunnel, even when the fixture home has no local
    // extensions to mirror.
    expect(events.map((event) => event.state)).toEqual(["connecting", "uploading", "syncing", "tunnel-up"])
    expect(events.every((event) => event.connectionId === saved.id)).toBe(true)
    await waitForLog(log, "tunnel:")
    const text = log()
    expect(text).toContain("cmd: true")
    expect(text).toContain("cmd: mkdir -p ~/.openscience/remote/bin ~/.openscience/remote/staging")
    expect(text).toContain("cmd: cat ~/.openscience/remote/BUILD 2>/dev/null || true")
    expect(text).toContain("server.pid")
    expect(text).toMatch(/upload:\s*4096/)
    expect(text).toContain(
      "cmd: mv ~/.openscience/remote/staging/openscience-9.9.9 ~/.openscience/remote/bin/openscience",
    )
    expect(text).toContain("chmod 755 ~/.openscience/remote/bin/openscience")
    // The uploaded bytes are verified against the local build's digest before
    // the BUILD marker records them.
    expect(text).toContain("cmd: sha256sum ~/.openscience/remote/bin/openscience")
    expect(text).toContain("local-bundled")
    expect(text).toContain("> ~/.openscience/remote/BUILD")
    expect(text).toContain("> ~/.openscience/remote/VERSION")
    expect(text).toContain("setsid nohup ~/.openscience/remote/bin/openscience serve --port 4096")
    // The deployed server gets an isolated data root so it neither reads nor
    // writes another OpenScience install's configuration.
    expect(text).toContain("OPENSCIENCE_DATA_DIR=$HOME/.openscience/remote/data")
    expect(text).toContain("XDG_CONFIG_HOME=$HOME/.openscience/remote/config")
    expect(text).toContain("echo $! > ~/.openscience/remote/server.pid")
    expect(text).toContain("-L 127.0.0.1:")
    expect(text).toContain(":127.0.0.1:4096")
    expect(text).toContain("sci@lab.example.com")
    // A second connect on a live tunnel is refused.
    const again = await manager.connect(saved.id)
    expect(again.ok).toBe(false)
    expect(again.error).toContain("already")
    // Disconnect reports closed and clears the gate for a later connect.
    events.length = 0
    await manager.disconnect(saved.id)
    expect(events.map((event) => event.state)).toEqual(["closed"])
    const third = await manager.connect(saved.id)
    expect(third.ok).toBe(true)
    await manager.disconnect(saved.id)
  })

  test("a foreign server on the remote port is left alone and this build takes a free port", async () => {
    const { manager, log } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n  User sci\n` })
    // Another OpenScience build (for example an older upstream release that
    // still asks for an account) already listens on 4096.
    process.env.FAKE_SSH_FOREIGN = "2.0.153"
    process.env.FAKE_SSH_LISTEN = "1096 4096"
    const events = []
    manager.onEvent((event) => events.push(event))
    const imported = manager.list()[0]
    const result = await manager.connect(imported.id)
    expect(result.ok).toBe(true)
    await waitForLog(log, "tunnel:")
    const text = log()
    // Ours starts next to the foreign server, and the tunnel points at ours.
    expect(text).toContain("serve --port 4097")
    expect(text).toContain(":127.0.0.1:4097")
    expect(text).not.toContain("serve --port 4096")
    expect(events.some((event) => event.message?.includes("another OpenScience (2.0.153)"))).toBe(true)
    // The fallback port is persisted, so the next connect reuses it.
    expect(manager.list()[0].remotePort).toBe(4097)
    await manager.disconnect(imported.id)
  })

  test("after the fallback, later connects reuse the chosen port without restarting", async () => {
    const { manager, log } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n` })
    process.env.FAKE_SSH_FOREIGN = "2.0.153"
    process.env.FAKE_SSH_LISTEN = "4096"
    const imported = manager.list()[0]
    expect((await manager.connect(imported.id)).ok).toBe(true)
    await manager.disconnect(imported.id)
    const starts = log().match(/serve --port 4097/g)?.length ?? 0
    expect(starts).toBe(1)
    expect((await manager.connect(imported.id)).ok).toBe(true)
    const after = log().match(/serve --port 4097/g)?.length ?? 0
    // The second connect found our own healthy server on 4097 and did not
    // start another one.
    expect(after).toBe(1)
    await manager.disconnect(imported.id)
  })

  test("an up-to-date remote skips the upload entirely", async () => {
    const { manager, log, digest } = setup()
    process.env.FAKE_SSH_VERSION = "9.9.9"
    process.env.FAKE_SSH_BUILD = `9.9.9 ${digest} local-bundled`
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(true)
    expect(events.map((event) => event.state)).toEqual(["connecting", "syncing", "tunnel-up"])
    const text = log()
    expect(text).not.toContain("upload:")
    expect(text).not.toContain("cmd: mv ~/.openscience")
    expect(text).not.toContain("sha256sum")
    expect(text).toContain("setsid nohup")
    await manager.disconnect(saved.id)
  })

  test("the same version with different bytes is replaced, not trusted", async () => {
    const { manager, log } = setup()
    process.env.FAKE_SSH_VERSION = "9.9.9"
    process.env.FAKE_SSH_BUILD = "9.9.9 0000000000000000000000000000000000000000000000000000000000000000 local-bundled"
    const result = await manager.connect(manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 }).id)
    // FAKE_SSH_DIGEST still reports the real local digest, so verification
    // passes after the replacement upload.
    expect(result.ok).toBe(true)
    expect(log()).toContain("upload:")
    await manager.disconnect(manager.list()[0].id)
  })

  test("a remote whose bytes do not match the local build fails loudly", async () => {
    const { manager, log } = setup()
    process.env.FAKE_SSH_DIGEST = "deadbeef"
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("does not match the local build")
    expect(events.at(-1)?.state).toBe("failed")
    // No tunnel is started for a build the desktop cannot vouch for.
    expect(log()).not.toContain("tunnel:")
  })

  test("a failed reachability probe reports failure without uploading or tunnelling", async () => {
    const { manager, log } = setup()
    process.env.FAKE_SSH_PROBE_EXIT = "7"
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({ label: "Lab", host: "lab.example.com", user: "sci", remotePort: 4096 })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Reaching sci@lab.example.com failed")
    expect(events.at(-1)?.state).toBe("failed")
    expect(events.at(-1)?.message).toContain("Reaching sci@lab.example.com failed")
    const text = log()
    expect(text).toContain("cmd: true")
    expect(text).not.toContain("upload:")
    expect(text).not.toContain("tunnel:")
  })

  test("a tunnel whose remote server never turns healthy reports the remote log tail", async () => {
    const { manager, log } = setup({ probe: async () => false, healthDeadlineMs: 300 })
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("did not become healthy")
    expect(result.error).toContain("Remote log tail")
    expect(result.error).toContain("FATAL: listen tcp 127.0.0.1:4096")
    expect(events.at(-1)?.state).toBe("failed")
    expect(log()).toContain("tail -c 2000 ~/.openscience/remote/server.log")
  })
})

describe("runtime selection", () => {
  test("setRuntime validates, persists, never emits, and survives a reload", () => {
    const { dir, manager, sshPath, sidecarPath } = setup()
    expect(manager.runtime()).toBe(null)
    const events = []
    manager.onEvent((event) => events.push(event))
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    manager.setRuntime(saved.id)
    expect(manager.runtime()).toBe(saved.id)
    // The selection is silent: the workspace learns about it over IPC, not
    // through the ssh event bus.
    expect(events).toEqual([])
    const stored = JSON.parse(readFileSync(path.join(dir, "ssh-connections.json"), "utf8"))
    expect(stored.runtime).toBe(saved.id)
    // A fresh manager over the same store keeps the selection.
    const reloaded = createSshManager({
      userData: dir,
      sidecarPath,
      version: "9.9.9",
      sshExecutable: sshPath,
      probe: async () => true,
      sshConfigPath: path.join(dir, "ssh-config"),
      homeDir: dir,
    })
    reloaded.stopAll()
    expect(reloaded.runtime()).toBe(saved.id)
    // Clearing persists too: the field is dropped so nothing is resurrected.
    manager.setRuntime(null)
    expect(manager.runtime()).toBe(null)
    const cleared = JSON.parse(readFileSync(path.join(dir, "ssh-connections.json"), "utf8"))
    expect("runtime" in cleared).toBe(false)
  })

  test("setRuntime rejects ids that are not in the current list", () => {
    const { manager } = setup()
    expect(() => manager.setRuntime("missing")).toThrow("No SSH connection has id missing")
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    manager.setRuntime(saved.id)
    expect(() => manager.setRuntime("sshconfig:ghost")).toThrow("No SSH connection has id sshconfig:ghost")
    expect(manager.runtime()).toBe(saved.id)
  })

  test("an imported alias can become the runtime", () => {
    const { manager } = setup({ sshConfig: `Host lab\n  HostName 10.0.0.9\n` })
    manager.setRuntime("sshconfig:lab")
    expect(manager.runtime()).toBe("sshconfig:lab")
  })

  test("record edits keep the stored runtime selection", () => {
    const { dir, manager } = setup()
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    manager.setRuntime(saved.id)
    manager.save({ ...saved, label: "Renamed" })
    expect(manager.runtime()).toBe(saved.id)
    const stored = JSON.parse(readFileSync(path.join(dir, "ssh-connections.json"), "utf8"))
    expect(stored.runtime).toBe(saved.id)
    expect(stored.connections[0].label).toBe("Renamed")
  })
})

describe("local extension sync", () => {
  // Seeds the local side of the sync items inside the fixture home, plus stale
  // remote state the sync has to overwrite (a merged file) or wipe (the
  // replaced config root).
  function seedHome(dir) {
    const write = (relative, content) => {
      const target = path.join(dir, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    write(".openscience/user-skills/lab-skill/SKILL.md", "local lab skill\n")
    write(".openscience/installed-skills/pkg/installed/SKILL.md", "installed skill\n")
    write(".claude/skills/claude-skill/SKILL.md", "claude skill\n")
    write(".config/openscience/settings.json", '{"local":true}\n')
    write(".openscience/auth.json", '{"token":"fresh"}\n')
    write(".openscience/credentials.key", "key-bytes\n")
    write(".openscience/remote/data/auth.json", '{"token":"stale"}\n')
    write(".openscience/remote/data/user-skills/remote-only/SKILL.md", "remote only\n")
    write(".openscience/remote/config/openscience/stale.txt", "stale config\n")
  }

  test("connect mirrors local skills, credentials and config into the remote roots", async () => {
    const { dir, manager, log } = setup()
    seedHome(dir)
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(true)
    await waitForLog(log, "sync:")
    // Merged skill directories land under the remote data root, and a skill
    // that only exists on the remote survives the merge.
    expect(
      readFileSync(path.join(dir, ".openscience", "remote", "data", "user-skills", "lab-skill", "SKILL.md"), "utf8"),
    ).toBe("local lab skill\n")
    expect(
      readFileSync(
        path.join(dir, ".openscience", "remote", "data", "installed-skills", "pkg", "installed", "SKILL.md"),
        "utf8",
      ),
    ).toBe("installed skill\n")
    expect(
      readFileSync(path.join(dir, ".openscience", "remote", "data", "user-skills", "remote-only", "SKILL.md"), "utf8"),
    ).toBe("remote only\n")
    // Single files are overwritten in place.
    expect(readFileSync(path.join(dir, ".openscience", "remote", "data", "auth.json"), "utf8")).toBe(
      '{"token":"fresh"}\n',
    )
    expect(readFileSync(path.join(dir, ".openscience", "remote", "data", "credentials.key"), "utf8")).toBe(
      "key-bytes\n",
    )
    // The .claude skills mirror into their unchanged location.
    expect(readFileSync(path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"), "utf8")).toBe("claude skill\n")
    // The replace item wiped the remote config root and re-created the app's
    // config directory (XDG_CONFIG_HOME + "openscience") from the local one.
    expect(
      readFileSync(path.join(dir, ".openscience", "remote", "config", "openscience", "settings.json"), "utf8"),
    ).toBe('{"local":true}\n')
    expect(existsSync(path.join(dir, ".openscience", "remote", "config", "openscience", "stale.txt"))).toBe(false)
    const text = log()
    // Exactly the items whose local side exists were synced; the replace
    // command stages the fresh config beside the real one and only swaps it in
    // after the tar stream has landed, and the merge ones only create the
    // parent.
    expect((text.match(/sync: /g) ?? []).length).toBe(6)
    expect(text).toMatch(
      /cmd: mkdir -p "\$HOME\/"'\.openscience\/remote' && rm -rf "\$HOME\/"'\.openscience\/remote\/config\.sync-staging'/,
    )
    expect(text).toMatch(
      /tar -C "\$HOME\/"'\.openscience\/remote\/config\.sync-staging' -xf - && rm -rf "\$HOME\/"'\.openscience\/remote\/config' && mv/,
    )
    // Remote paths are anchored at the remote $HOME, never at the local home's
    // absolute spelling, which only matches when both homes are identical.
    expect(text).toContain(
      "cmd: mkdir -p \"$HOME/\"'.openscience/remote/data' && tar -C \"$HOME/\"'.openscience/remote/data' -xf -",
    )
    expect(text).not.toMatch(/'(\/|[A-Za-z]:\\)[^']*openscience\/remote\/data/)
    // No remote command line may carry the local home at all.
    expect(text).not.toContain(dir)
    expect(text).not.toContain("credentials.json")
    expect(text).not.toContain("mcp-auth.json")
    expect(text).not.toContain("compute.key")
    expect(text).not.toContain("settings-compute.json")
    await manager.disconnect(saved.id)
  })

  test("a failed replace item leaves the remote config root and the local items untouched", async () => {
    const { dir, manager, log } = setup()
    seedHome(dir)
    // The replace item's tar fails mid-transfer: the staging swap means the
    // running server's config root must survive, and no staging leftovers stay
    // behind.
    process.env.FAKE_SSH_REPLACE_TAR_EXIT = "2"
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const events = []
    manager.onEvent((event) => events.push(event))
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(true)
    await waitForLog(log, "tunnel:")
    // The stale remote config root is exactly as the sync found it.
    expect(readFileSync(path.join(dir, ".openscience", "remote", "config", "openscience", "stale.txt"), "utf8")).toBe(
      "stale config\n",
    )
    // The failed attempt cleaned up its staging directory.
    expect(existsSync(path.join(dir, ".openscience", "remote", "config.sync-staging"))).toBe(false)
    // The first failure stops the remaining items: nothing after the replace
    // item was synced.
    expect(readFileSync(path.join(dir, ".openscience", "remote", "data", "auth.json"), "utf8")).toBe(
      '{"token":"stale"}\n',
    )
    const skipped = events.find(
      (event) => event.state === "syncing" && event.message?.includes("Local extension sync skipped:"),
    )
    expect(skipped).toBeDefined()
    // Only the three merge items ahead of the replace item made it through.
    expect((log().match(/sync: /g) ?? []).length).toBe(3)
    await manager.disconnect(saved.id)
  })

  test("connect reports the syncing phase between deploy and the tunnel", async () => {
    const { dir, manager } = setup()
    seedHome(dir)
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const events = []
    manager.onEvent((event) => events.push(event))
    expect((await manager.connect(saved.id)).ok).toBe(true)
    expect(events.map((event) => event.state)).toEqual(["connecting", "uploading", "syncing", "tunnel-up"])
    const syncing = events.find((event) => event.state === "syncing")
    expect(syncing.connectionId).toBe(saved.id)
    expect(syncing.message).toBe("Syncing local skills, plugins and config to lab.example.com")
    await manager.disconnect(saved.id)
  })

  test("a failed sync is soft: connect still succeeds and the event explains the skip", async () => {
    const { dir, manager, log } = setup()
    seedHome(dir)
    process.env.FAKE_SSH_SYNC_EXIT = "9"
    const saved = manager.save({ label: "Lab", host: "lab.example.com", remotePort: 4096 })
    const events = []
    manager.onEvent((event) => events.push(event))
    const result = await manager.connect(saved.id)
    expect(result.ok).toBe(true)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await waitForLog(log, "tunnel:")
    const skipped = events.find(
      (event) => event.state === "syncing" && event.message?.includes("Local extension sync skipped:"),
    )
    expect(skipped).toBeDefined()
    expect(skipped.connectionId).toBe(saved.id)
    // The skip message carries the underlying ssh failure.
    expect(skipped.message).toContain("Syncing")
    expect(skipped.message).toContain("exited with code 9")
    // Nothing was unpacked: the stale remote state is untouched, and the
    // first failure stops the remaining items.
    expect(readFileSync(path.join(dir, ".openscience", "remote", "data", "auth.json"), "utf8")).toBe(
      '{"token":"stale"}\n',
    )
    expect(readFileSync(path.join(dir, ".openscience", "remote", "config", "openscience", "stale.txt"), "utf8")).toBe(
      "stale config\n",
    )
    expect((log().match(/sync: /g) ?? []).length).toBe(0)
    await manager.disconnect(saved.id)
  })
})
