/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENSCIENCE_VERSION?: string
  readonly VITE_OPENSCIENCE_SERVER_HOST: string
  readonly VITE_OPENSCIENCE_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Desktop SSH bridge contract, mirrored by the preload "openscienceDesktop.ssh"
// field and the "openscience:ssh:*" IPC channels. Ambient so the Platform type
// and the server dialog share one shape without an import cycle.
interface SSHConnectionRecord {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  identityFile?: string
  remotePort: number
  createdAt: number
  /** Present on records imported from ~/.ssh/config: the OpenSSH alias itself. */
  alias?: string
  /** "ssh-config" marks a derived, read-only record; absent means user-entered. */
  origin?: "ssh-config"
}

interface SSHConnectionInput {
  id?: string
  label: string
  host: string
  user?: string
  port?: number
  identityFile?: string
  remotePort: number
}

interface SSHEvent {
  connectionId: string
  state: "connecting" | "syncing" | "uploading" | "tunnel-up" | "closed" | "failed"
  message?: string
}

interface SSHBridge {
  list(): Promise<SSHConnectionRecord[]>
  sync(): Promise<{ imported: number; total: number }>
  save(input: SSHConnectionInput): Promise<SSHConnectionRecord>
  remove(id: string): Promise<void>
  connect(id: string, purpose?: "runtime" | "window"): Promise<{ ok: boolean; url?: string; error?: string }>
  disconnect(id: string): Promise<void>
  onEvent(cb: (event: SSHEvent) => void): () => void
  /** Runtime mode: make this connection back the main window's server. */
  setRuntime(id: string | null): Promise<void>
  /** The connection id currently powering the main window, or null for local. */
  runtime(): Promise<string | null>
  /** Fired when runtime mode switches the main window's backing server. */
  onServerUse(cb: (event: { url: string; connectionId: string }) => void): () => void
}

interface Window {
  openscienceDesktop?: { openWorkspace(url: string): Promise<boolean>; ssh?: SSHBridge }
  __OPENSCIENCE_BASE_URL__?: string
}
