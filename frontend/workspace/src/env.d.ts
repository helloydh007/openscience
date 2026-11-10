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
  state: "connecting" | "uploading" | "tunnel-up" | "closed" | "failed"
  message?: string
}

interface SSHBridge {
  list(): Promise<SSHConnectionRecord[]>
  save(input: SSHConnectionInput): Promise<SSHConnectionRecord>
  remove(id: string): Promise<void>
  connect(id: string): Promise<{ ok: boolean; url?: string; error?: string }>
  disconnect(id: string): Promise<void>
  onEvent(cb: (event: SSHEvent) => void): () => void
}

interface Window {
  openscienceDesktop?: { openWorkspace(url: string): Promise<boolean>; ssh?: SSHBridge }
  __OPENSCIENCE_BASE_URL__?: string
}
