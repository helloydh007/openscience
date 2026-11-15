import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { extensionSyncItems } from "../src/remote-sync.mjs"

// Pure unit tests for the sync plan: the documented item paths, the replace
// flag, and the existsSync filter. The tar/ssh integration lives in
// ssh-connections.test.mjs against the fake ssh.
describe("extensionSyncItems", () => {
  function tempHome() {
    return mkdtempSync(path.join(os.tmpdir(), "remote-sync-test-"))
  }

  test("keeps existing items with their documented paths and drops missing ones", () => {
    const home = tempHome()
    try {
      const touch = (relative) => mkdirSync(path.join(home, relative), { recursive: true })
      touch(".openscience/user-skills")
      touch(".openscience/installed-skills")
      touch(".claude/skills")
      touch(".config/openscience")
      writeFileSync(path.join(home, ".openscience", "auth.json"), "{}")
      writeFileSync(path.join(home, ".openscience", "credentials.key"), "k")
      const items = extensionSyncItems(home)
      // Local sides are absolute local paths; remote sides are POSIX paths
      // relative to the SSH user's home on the remote host, so they stay
      // correct when the remote home differs from the local one.
      expect(items).toEqual([
        {
          local: path.join(home, ".openscience", "user-skills"),
          remote: ".openscience/remote/data/user-skills",
          replace: false,
        },
        {
          local: path.join(home, ".openscience", "installed-skills"),
          remote: ".openscience/remote/data/installed-skills",
          replace: false,
        },
        {
          local: path.join(home, ".claude", "skills"),
          remote: ".claude/skills",
          replace: false,
        },
        {
          local: path.join(home, ".config", "openscience"),
          remote: ".openscience/remote/config",
          replace: true,
        },
        {
          local: path.join(home, ".openscience", "auth.json"),
          remote: ".openscience/remote/data/auth.json",
          replace: false,
        },
        {
          local: path.join(home, ".openscience", "credentials.key"),
          remote: ".openscience/remote/data/credentials.key",
          replace: false,
        },
      ])
      expect(items.every((item) => path.isAbsolute(item.local) && !path.isAbsolute(item.remote))).toBe(true)
      expect(items.every((item) => !item.remote.includes("\\"))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a fully populated home yields all ten items in a stable order", () => {
    const home = tempHome()
    try {
      const touch = (relative) => mkdirSync(path.join(home, relative), { recursive: true })
      touch(".openscience/user-skills")
      touch(".openscience/installed-skills")
      touch(".claude/skills")
      touch(".config/openscience")
      for (const name of [
        "auth.json",
        "credentials.json",
        "credentials.key",
        "mcp-auth.json",
        "compute.key",
        "settings-compute.json",
      ])
        writeFileSync(path.join(home, ".openscience", name), "{}")
      const items = extensionSyncItems(home)
      expect(items).toHaveLength(10)
      expect(items.filter((item) => item.replace)).toEqual([
        {
          local: path.join(home, ".config", "openscience"),
          remote: ".openscience/remote/config",
          replace: true,
        },
      ])
      expect(items.map((item) => path.basename(item.local))).toEqual([
        "user-skills",
        "installed-skills",
        "skills",
        "openscience",
        "auth.json",
        "credentials.json",
        "credentials.key",
        "mcp-auth.json",
        "compute.key",
        "settings-compute.json",
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an empty home yields no items", () => {
    const home = tempHome()
    try {
      expect(extensionSyncItems(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
