import { existsSync } from "node:fs"
import path from "node:path"

// The local extension state the desktop mirrors into a remote runtime over
// SSH. The deployed remote server runs with OPENSCIENCE_DATA_DIR=
// $HOME/.openscience/remote/data and XDG_CONFIG_HOME=$HOME/.openscience/
// remote/config (see ssh-connections.mjs), so skills and credentials merge
// into the remote data root while the desktop's own config directory replaces
// the remote config root.
//
// Pure and Electron-free: the SSH manager hands this a home directory and
// packs whatever survives the existsSync filter into tar archives. Items whose
// local side does not exist are dropped — there is nothing to sync, and a
// missing local auth.json must never delete or blank the remote one.

// Credential and settings files that live directly in the data root and are
// mirrored one-for-one into the remote data root. The remote server reads them
// from OPENSCIENCE_DATA_DIR, so a synced file takes effect on the next remote
// server start.
const DATA_FILES = [
  "auth.json",
  "credentials.json",
  "credentials.key",
  "mcp-auth.json",
  "compute.key",
  "settings-compute.json",
]

/**
 * The sync plan for one home directory: {local, remote, replace} triples in a
 * stable order, with every item whose local side is missing already removed.
 *
 * `local` is an absolute local path. `remote` is a POSIX path relative to the
 * SSH user's own home directory on the remote host — never a copy of the local
 * home's absolute spelling. The deployed server reads OPENSCIENCE_DATA_DIR
 * ($HOME/.openscience/remote/data) and XDG_CONFIG_HOME ($HOME/.openscience/
 * remote/config), so only a remote-relative path stays correct when the two
 * homes differ (different user names, macOS to Linux, and so on). ssh runs
 * these commands with the remote home as its working directory, and
 * ssh-connections.mjs prefixes them with the remote $HOME when it builds the
 * shell command.
 *
 * Directory items sync the directory itself, so the tar entry name is the
 * local basename and extraction happens into the remote's parent directory —
 * for the merge items that recreates the destination, and for the replace
 * item it re-creates <root>/openscience, exactly where the backend resolves
 * its config directory under XDG_CONFIG_HOME (backend/cli/src/global/index.ts
 * joins the XDG root with "openscience").
 */
export function extensionSyncItems(homeDir) {
  if (typeof homeDir !== "string" || homeDir.length === 0) return []
  const openscience = path.join(homeDir, ".openscience")
  // Forward slashes on purpose: these are remote shell paths, not local ones,
  // so they must not inherit the local platform's separator.
  const remoteData = ".openscience/remote/data"
  const items = [
    // Skill directories merge: the remote keeps any skill that exists only
    // there, and a synced entry overwrites just its own files.
    { local: path.join(openscience, "user-skills"), remote: `${remoteData}/user-skills`, replace: false },
    {
      local: path.join(openscience, "installed-skills"),
      remote: `${remoteData}/installed-skills`,
      replace: false,
    },
    { local: path.join(homeDir, ".claude", "skills"), remote: ".claude/skills", replace: false },
    // The desktop's config directory replaces the remote config root wholesale:
    // whatever the remote had is wiped and rebuilt from the local side.
    { local: path.join(homeDir, ".config", "openscience"), remote: ".openscience/remote/config", replace: true },
    ...DATA_FILES.map((name) => ({
      local: path.join(openscience, name),
      remote: `${remoteData}/${name}`,
      replace: false,
    })),
  ]
  return items.filter((item) => existsSync(item.local))
}
