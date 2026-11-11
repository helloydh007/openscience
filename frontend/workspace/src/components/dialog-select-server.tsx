import { createResource, createEffect, createMemo, onCleanup, onMount, Show, createSignal, For } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useDialog } from "@synsci/ui/context/dialog"
import { Dialog } from "@synsci/ui/dialog"
import { List } from "@synsci/ui/list"
import { Button } from "@synsci/ui/button"
import { IconButton } from "@synsci/ui/icon-button"
import { TextField } from "@synsci/ui/text-field"
import { normalizeServerUrl, serverDisplayName, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { DropdownMenu } from "@synsci/ui/dropdown-menu"
import { Tooltip } from "@synsci/ui/tooltip"
import { showToast } from "@synsci/ui/toast"
import "./dialog-select-server.css"

type ServerStatus = { healthy: boolean | undefined; version?: string }

function serverVersionLabel(value: string) {
  return value.trim().toLocaleLowerCase() === "local" ? "Local" : value
}

interface AddRowProps {
  value: string
  label: string
  placeholder: string
  adding: boolean
  error: string
  status: boolean | undefined
  saveLabel: string
  cancelLabel: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onSave: () => void
  onCancel: () => void
}

interface EditRowProps {
  value: string
  label: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  saveLabel: string
  cancelLabel: string
  canSave: boolean
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onSave: () => void
  onCancel: () => void
}

async function checkHealth(url: string, platform: ReturnType<typeof usePlatform>): Promise<ServerStatus> {
  // A remote runtime is checked by the desktop main process only when the
  // user opens it. The local renderer keeps its same-origin CSP.
  if (platform.openWorkspace && URL.canParse(url) && new URL(url).origin !== window.location.origin)
    return { healthy: undefined }
  const signal = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(3000)
  const sdk = createOpenScienceClient({
    baseUrl: url,
    fetch: platform.fetch,
    signal,
  })
  return sdk.global
    .health()
    .then((x) => ({ healthy: x.data?.healthy === true, version: x.data?.version }))
    .catch(() => ({ healthy: false }))
}

function AddRow(props: AddRowProps) {
  return (
    <form
      class="server-dialog__form"
      aria-label={props.label}
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      <div class="server-dialog__form-field [&_[data-slot=input-wrapper]]:relative">
        <div
          classList={{
            "size-1.5 rounded-full absolute left-3 top-1/2 -translate-y-1/2 z-10 pointer-events-none": true,
            "bg-icon-success-base": props.status === true,
            "bg-icon-critical-base": props.status === false,
            "bg-border-weak-base": props.status === undefined,
          }}
          ref={(el) => {
            // Position relative to input-wrapper
            requestAnimationFrame(() => {
              const wrapper = el.parentElement?.querySelector('[data-slot="input-wrapper"]')
              if (wrapper instanceof HTMLElement) {
                wrapper.appendChild(el)
              }
            })
          }}
        />
        <TextField
          type="text"
          label={props.label}
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.adding}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          class="pl-7"
        />
      </div>
      <div class="server-dialog__form-actions">
        <Button type="button" size="normal" variant="ghost" disabled={props.adding} onClick={props.onCancel}>
          {props.cancelLabel}
        </Button>
        <Button type="submit" size="normal" variant="primary" disabled={props.adding || !props.value.trim()}>
          {props.saveLabel}
        </Button>
      </div>
    </form>
  )
}

function EditRow(props: EditRowProps) {
  return (
    <form
      class="server-dialog__form"
      aria-label={props.label}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave()
      }}
    >
      <div
        classList={{
          "server-dialog__status mt-[13px]": true,
          "bg-icon-success-base": props.status === true,
          "bg-icon-critical-base": props.status === false,
          "bg-border-weak-base": props.status === undefined,
        }}
      />
      <div class="server-dialog__form-field">
        <TextField
          type="text"
          label={props.label}
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.busy}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
        />
      </div>
      <div class="server-dialog__form-actions">
        <Button type="button" size="normal" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {props.cancelLabel}
        </Button>
        <Button type="submit" size="normal" variant="primary" disabled={props.busy || !props.canSave}>
          {props.saveLabel}
        </Button>
      </div>
    </form>
  )
}

type SSHStatus = "idle" | "connecting" | "uploading" | "connected" | "failed"

const SSH_FORM_DEFAULTS = { label: "", host: "", user: "", port: "22", identityFile: "", remotePort: "4096" }

function sshEventStatus(state: SSHEvent["state"]): SSHStatus {
  if (state === "tunnel-up") return "connected"
  if (state === "closed") return "idle"
  return state
}

function sshEndpoint(connection: SSHConnectionRecord) {
  const endpoint = connection.port ? `${connection.host}:${connection.port}` : connection.host
  // An imported row is an alias: show the alias first and what OpenSSH will
  // resolve it to, so two aliases pointing at one host stay distinguishable.
  if (connection.origin === "ssh-config" && connection.alias && connection.alias !== connection.host) {
    return `${connection.alias} → ${endpoint}`
  }
  return endpoint
}

function sshStatusClass(value: SSHStatus) {
  if (value === "connected") return "bg-icon-success-base"
  if (value === "failed") return "bg-icon-critical-base"
  if (value === "connecting" || value === "uploading") return "bg-icon-warning-base"
  return "bg-border-weak-base"
}

function parsePort(value: string) {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

interface SSHSectionProps {
  ssh: NonNullable<ReturnType<typeof usePlatform>["ssh"]>
  onClose: () => void
}

function SSHSection(props: SSHSectionProps) {
  const [connections, setConnections] = createSignal<SSHConnectionRecord[]>([])
  const [status, setStatus] = createStore<Record<string, SSHStatus>>({})
  const [form, setForm] = createStore({ ...SSH_FORM_DEFAULTS })
  const [showForm, setShowForm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let listGeneration = 0

  const report = (title: string, error: unknown) => {
    showToast({
      variant: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    })
  }

  const refresh = async () => {
    const generation = ++listGeneration
    try {
      const list = await props.ssh.list()
      if (generation !== listGeneration) return
      setConnections(list)
    } catch (error) {
      if (generation !== listGeneration) return
      report("SSH servers unavailable", error)
    }
  }

  onMount(() => void refresh())
  // Events keep the per-connection dots current; dropping the subscription on
  // unmount keeps the bridge from holding renderer callbacks.
  onCleanup(props.ssh.onEvent((event) => setStatus(event.connectionId, sshEventStatus(event.state))))

  const importedCount = () => connections().filter((connection) => connection.origin === "ssh-config").length

  // The import is derived from ~/.ssh/config on every list; Sync makes the
  // derived set explicit after the person edits that file with the app open.
  const handleSync = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await props.ssh.sync()
      await refresh()
    } catch (error) {
      report("SSH config import failed", error)
    } finally {
      setBusy(false)
    }
  }

  const resetForm = () => {
    setForm({ ...SSH_FORM_DEFAULTS })
    setShowForm(false)
  }

  const handleSave = async () => {
    const label = form.label.trim()
    const host = form.host.trim()
    if (busy() || !label || !host) return
    setBusy(true)
    try {
      await props.ssh.save({
        label,
        host,
        user: form.user.trim() || undefined,
        port: parsePort(form.port),
        identityFile: form.identityFile.trim() || undefined,
        remotePort: parsePort(form.remotePort) ?? 4096,
      })
      resetForm()
      await refresh()
    } catch (error) {
      report("SSH server not saved", error)
    } finally {
      setBusy(false)
    }
  }

  const handleConnect = async (connection: SSHConnectionRecord) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await props.ssh.connect(connection.id)
      if (result.ok && result.url) {
        // The main process opens the remote window; this dialog is done.
        props.onClose()
        return
      }
      report("SSH connection failed", result.error ?? `Could not connect to ${connection.label}.`)
    } catch (error) {
      report("SSH connection failed", error)
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (connection: SSHConnectionRecord) => {
    if (busy()) return
    setBusy(true)
    try {
      await props.ssh.disconnect(connection.id)
    } catch (error) {
      report("SSH disconnect failed", error)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (connection: SSHConnectionRecord) => {
    if (busy()) return
    setBusy(true)
    try {
      await props.ssh.remove(connection.id)
      await refresh()
    } catch (error) {
      report("SSH server not removed", error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="server-dialog__ssh">
      <div class="server-dialog__ssh-header">
        <div class="server-dialog__ssh-heading">
          <span class="server-dialog__ssh-title">SSH servers</span>
          <span class="server-dialog__ssh-meta">
            <Show when={importedCount() > 0} fallback={<>~/.ssh/config is imported automatically</>}>
              {importedCount()} from ~/.ssh/config (read-only)
            </Show>
          </span>
        </div>
        <div class="server-dialog__ssh-header-actions">
          <Button
            variant="ghost"
            icon="refresh"
            size="normal"
            disabled={busy()}
            class="server-dialog__add-button"
            onClick={() => void handleSync()}
          >
            Sync
          </Button>
          <Show when={!showForm()}>
            <Button
              variant="ghost"
              icon="plus-small"
              size="normal"
              disabled={busy()}
              class="server-dialog__add-button"
              onClick={() => setShowForm(true)}
            >
              Add SSH server
            </Button>
          </Show>
        </div>
      </div>
      <div class="server-dialog__ssh-list">
        <Show
          when={connections().length}
          fallback={
            <div class="server-dialog__ssh-empty">
              No SSH servers saved yet. Hosts in ~/.ssh/config are imported automatically.
            </div>
          }
        >
          <For each={connections()}>
            {(connection) => {
              const state = () => status[connection.id] ?? "idle"
              const active = () => state() === "connected" || state() === "connecting" || state() === "uploading"
              return (
                <div class="server-dialog__ssh-row">
                  <div class={`server-dialog__status ${sshStatusClass(state())}`} />
                  <div class="server-dialog__ssh-identity">
                    <span class="server-dialog__ssh-label">
                      {connection.label}
                      <Show when={connection.origin === "ssh-config"}>
                        <span class="server-dialog__ssh-badge">~/.ssh/config</span>
                      </Show>
                    </span>
                    <span class="server-dialog__ssh-host">{sshEndpoint(connection)}</span>
                  </div>
                  <div class="server-dialog__ssh-actions">
                    <Show
                      when={active()}
                      fallback={
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={busy()}
                          onClick={() => void handleConnect(connection)}
                        >
                          Connect
                        </Button>
                      }
                    >
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy()}
                        onClick={() => void handleDisconnect(connection)}
                      >
                        Disconnect
                      </Button>
                    </Show>
                    <Show when={connection.origin !== "ssh-config"}>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={busy()}
                        onClick={() => void handleRemove(connection)}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
      <Show when={showForm()}>
        <form
          class="server-dialog__ssh-form"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div class="server-dialog__ssh-fields">
            <TextField
              type="text"
              label="Label"
              hideLabel
              placeholder="Label"
              value={form.label}
              autofocus
              disabled={busy()}
              onChange={(value) => setForm("label", value)}
            />
            <TextField
              type="text"
              label="Host"
              hideLabel
              placeholder="Host"
              value={form.host}
              disabled={busy()}
              onChange={(value) => setForm("host", value)}
            />
            <TextField
              type="text"
              label="User"
              hideLabel
              placeholder="User (optional)"
              value={form.user}
              disabled={busy()}
              onChange={(value) => setForm("user", value)}
            />
            <TextField
              type="text"
              label="Port"
              hideLabel
              placeholder="Port (optional, 22)"
              value={form.port}
              disabled={busy()}
              onChange={(value) => setForm("port", value)}
            />
            <TextField
              type="text"
              label="Identity file"
              hideLabel
              placeholder="Identity file (optional)"
              value={form.identityFile}
              disabled={busy()}
              onChange={(value) => setForm("identityFile", value)}
            />
            <TextField
              type="text"
              label="Remote port"
              hideLabel
              placeholder="Remote port (4096)"
              value={form.remotePort}
              disabled={busy()}
              onChange={(value) => setForm("remotePort", value)}
            />
          </div>
          <div class="server-dialog__form-actions">
            <Button type="button" size="small" variant="ghost" disabled={busy()} onClick={resetForm}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="small"
              variant="primary"
              disabled={busy() || !form.label.trim() || !form.host.trim()}
            >
              Save
            </Button>
          </div>
        </form>
      </Show>
    </div>
  )
}

export function DialogSelectServer() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore({
    status: {} as Record<string, ServerStatus | undefined>,
    addServer: {
      url: "",
      adding: false,
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      error: "",
      busy: false,
      status: undefined as boolean | undefined,
    },
  })
  let healthGeneration = 0
  let addPreviewGeneration = 0
  let editPreviewGeneration = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    healthGeneration++
    addPreviewGeneration++
    editPreviewGeneration++
  })
  const [defaultUrl, defaultUrlActions] = createResource(
    async () => {
      try {
        const url = await platform.getDefaultServerUrl?.()
        if (!url) return null
        return normalizeServerUrl(url) ?? null
      } catch (err) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },
    { initialValue: null },
  )
  const canDefault = createMemo(
    () => !platform.openWorkspace && !!platform.getDefaultServerUrl && !!platform.setDefaultServerUrl,
  )

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (
    value: string,
    current: () => boolean,
    setStatus: (value: boolean | undefined) => void,
  ) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const result = await checkHealth(normalized, platform)
    if (disposed || !current()) return
    setStatus(result.healthy)
  }

  const resetAdd = () => {
    addPreviewGeneration++
    setStore("addServer", {
      url: "",
      error: "",
      showForm: false,
      status: undefined,
    })
  }

  const resetEdit = () => {
    editPreviewGeneration++
    setStore("editServer", {
      id: undefined,
      value: "",
      error: "",
      status: undefined,
      busy: false,
    })
  }

  const replaceServer = (original: string, next: string) => {
    const active = server.url
    const nextActive = active === original ? next : active

    server.add(next)
    if (nextActive) server.setActive(nextActive)
    server.remove(original)
  }

  const items = createMemo(() => {
    const current = server.url
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => x === server.url) ?? items()[0])

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerStatus) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(store.status[a]) - rank(store.status[b])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function refreshHealth() {
    const generation = ++healthGeneration
    const urls = items()
    const results: Record<string, ServerStatus> = {}
    await Promise.all(
      urls.map(async (url) => {
        results[url] = await checkHealth(url, platform)
      }),
    )
    const current = items()
    if (
      disposed ||
      generation !== healthGeneration ||
      current.length !== urls.length ||
      current.some((url, index) => url !== urls[index])
    )
      return
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    items()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  const openWorkspace = async (value: string) => {
    const opened = await platform.openWorkspace!(value)
    if (opened) server.add(value, false)
    return opened
  }

  async function select(value: string, persist?: boolean) {
    if (platform.openWorkspace && new URL(value).origin !== window.location.origin) {
      try {
        if (await openWorkspace(value)) dialog.close()
      } catch (error) {
        showToast({
          variant: "error",
          title: language.t("dialog.server.add.error"),
          description: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    if (!persist && store.status[value]?.healthy === false) return
    dialog.close()
    if (persist) {
      server.add(value)
      navigate("/")
      return
    }
    server.setActive(value)
    navigate("/")
  }

  const handleAddChange = (value: string) => {
    if (store.addServer.adding) return
    const generation = ++addPreviewGeneration
    setStore("addServer", { url: value, error: "" })
    void previewStatus(
      value,
      () => generation === addPreviewGeneration && store.addServer.url === value && !store.addServer.adding,
      (next) => setStore("addServer", { status: next }),
    )
  }

  const scrollListToBottom = () => {
    const scroll = document.querySelector<HTMLDivElement>('[data-component="list"] [data-slot="list-scroll"]')
    if (!scroll) return
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight
    })
  }

  const handleEditChange = (value: string) => {
    if (store.editServer.busy) return
    const generation = ++editPreviewGeneration
    setStore("editServer", { value, error: "" })
    void previewStatus(
      value,
      () => generation === editPreviewGeneration && store.editServer.value === value && !store.editServer.busy,
      (next) => setStore("editServer", { status: next }),
    )
  }

  async function handleAdd(value: string) {
    if (store.addServer.adding) return
    addPreviewGeneration++
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetAdd()
      return
    }

    setStore("addServer", { adding: true, error: "" })

    if (platform.openWorkspace) {
      try {
        if (await openWorkspace(normalized)) {
          resetAdd()
          dialog.close()
        }
      } catch (error) {
        setStore("addServer", { error: error instanceof Error ? error.message : String(error) })
      } finally {
        setStore("addServer", { adding: false })
      }
      return
    }
    const result = await checkHealth(normalized, platform)
    if (disposed) return
    setStore("addServer", { adding: false })

    if (!result.healthy) {
      setStore("addServer", { error: language.t("dialog.server.add.error") })
      return
    }

    resetAdd()
    await select(normalized, true)
  }

  async function handleEdit(original: string, value: string) {
    if (store.editServer.busy) return
    editPreviewGeneration++
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetEdit()
      return
    }

    if (normalized === original) {
      resetEdit()
      return
    }

    setStore("editServer", { busy: true, error: "" })

    if (platform.openWorkspace) {
      try {
        if (await openWorkspace(normalized)) {
          if (original !== server.url) server.remove(original)
          resetEdit()
        }
      } catch (error) {
        setStore("editServer", { error: error instanceof Error ? error.message : String(error) })
      } finally {
        setStore("editServer", { busy: false })
      }
      return
    }
    const result = await checkHealth(normalized, platform)
    if (disposed) return
    setStore("editServer", { busy: false })

    if (!result.healthy) {
      setStore("editServer", { error: language.t("dialog.server.add.error") })
      return
    }

    replaceServer(original, normalized)

    resetEdit()
  }

  const handleAddKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetAdd()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleAdd(store.addServer.url)
  }

  const handleEditKey = (event: KeyboardEvent, original: string) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetEdit()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleEdit(original, store.editServer.value)
  }

  async function handleRemove(url: string) {
    server.remove(url)
  }

  return (
    <Dialog
      title={language.t("dialog.server.title")}
      description={language.t(
        platform.openWorkspace ? "dialog.server.desktop.description" : "dialog.server.description",
      )}
      class="server-dialog"
      fit
      transition
    >
      <div class="server-dialog__content">
        <List
          search={{ placeholder: language.t("dialog.server.search.placeholder"), autofocus: false }}
          noInitialSelection
          emptyMessage={language.t("dialog.server.empty")}
          items={sortedItems}
          key={(x) => x}
          onSelect={(x) => {
            if (x) select(x)
          }}
          onFilter={(value) => {
            if (value && store.addServer.showForm && !store.addServer.adding) {
              resetAdd()
            }
          }}
          itemWrapper={(item, node) => (
            <Show when={store.editServer.id === item} fallback={node}>
              <div data-slot="list-item-editor" data-key={item} class="server-dialog__editor">
                <EditRow
                  value={store.editServer.value}
                  label={language.t("dialog.server.add.url")}
                  placeholder={language.t("dialog.server.add.placeholder")}
                  busy={store.editServer.busy}
                  error={store.editServer.error}
                  status={store.editServer.status}
                  saveLabel={language.t("dialog.server.action.save")}
                  cancelLabel={language.t("dialog.server.action.cancel")}
                  canSave={Boolean(store.editServer.value.trim()) && store.editServer.value !== item}
                  onChange={handleEditChange}
                  onKeyDown={(event) => handleEditKey(event, item)}
                  onSave={() => void handleEdit(item, store.editServer.value)}
                  onCancel={resetEdit}
                />
              </div>
            </Show>
          )}
          divider={true}
          class="server-dialog__list"
          add={
            store.addServer.showForm
              ? {
                  render: () => (
                    <AddRow
                      value={store.addServer.url}
                      label={language.t("dialog.server.add.url")}
                      placeholder={language.t("dialog.server.add.placeholder")}
                      adding={store.addServer.adding}
                      error={store.addServer.error}
                      status={store.addServer.status}
                      saveLabel={
                        store.addServer.adding
                          ? language.t("dialog.server.add.checking")
                          : language.t(
                              platform.openWorkspace ? "dialog.server.desktop.open" : "dialog.server.add.button",
                            )
                      }
                      cancelLabel={language.t("dialog.server.action.cancel")}
                      onChange={handleAddChange}
                      onKeyDown={handleAddKey}
                      onSave={() => void handleAdd(store.addServer.url)}
                      onCancel={resetAdd}
                    />
                  ),
                }
              : undefined
          }
        >
          {(i) => {
            const [truncated, setTruncated] = createSignal(false)
            let nameRef: HTMLSpanElement | undefined
            let versionRef: HTMLSpanElement | undefined

            const check = () => {
              const nameTruncated = nameRef ? nameRef.scrollWidth > nameRef.clientWidth : false
              const versionTruncated = versionRef ? versionRef.scrollWidth > versionRef.clientWidth : false
              setTruncated(nameTruncated || versionTruncated)
            }

            createEffect(() => {
              check()
              window.addEventListener("resize", check)
              onCleanup(() => window.removeEventListener("resize", check))
            })

            const tooltipValue = () => {
              const name = serverDisplayName(i)
              const version = store.status[i]?.version
              return (
                <span class="flex items-center gap-2">
                  <span>{name}</span>
                  <Show when={version}>
                    <span class="text-text-invert-base">{version}</span>
                  </Show>
                </span>
              )
            }

            return (
              <div class="server-dialog__row group/item">
                <Tooltip value={tooltipValue()} placement="top" inactive={!truncated()}>
                  <div class="server-dialog__identity" classList={{ "opacity-50": store.status[i]?.healthy === false }}>
                    <div
                      classList={{
                        "server-dialog__status": true,
                        "bg-icon-success-base": store.status[i]?.healthy === true,
                        "bg-icon-critical-base": store.status[i]?.healthy === false,
                        "bg-border-weak-base": store.status[i] === undefined,
                      }}
                    />
                    <span ref={nameRef} class="server-dialog__name">
                      {serverDisplayName(i)}
                    </span>
                    <Show when={store.status[i]?.version}>
                      {(version) => (
                        <span ref={versionRef} class="server-dialog__badge">
                          {serverVersionLabel(version())}
                        </span>
                      )}
                    </Show>
                    <Show when={defaultUrl() === i}>
                      <span class="server-dialog__badge">{language.t("dialog.server.status.default")}</span>
                    </Show>
                    <Show when={current() === i}>
                      <span class="server-dialog__badge server-dialog__badge--current">
                        {language.t("dialog.server.current")}
                      </span>
                    </Show>
                  </div>
                </Tooltip>
                <div class="server-dialog__actions">
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="more-horizontal"
                      variant="ghost"
                      class="server-dialog__menu-button"
                      aria-label={language.t("common.moreOptions")}
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            resetAdd()
                            editPreviewGeneration++
                            setStore("editServer", {
                              id: i,
                              value: i,
                              error: "",
                              status: store.status[i]?.healthy,
                            })
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={canDefault() && defaultUrl() !== i}>
                          <DropdownMenu.Item
                            onSelect={async () => {
                              try {
                                await platform.setDefaultServerUrl?.(i)
                                defaultUrlActions.mutate(i)
                              } catch (err) {
                                showToast({
                                  variant: "error",
                                  title: language.t("common.requestFailed"),
                                  description: err instanceof Error ? err.message : String(err),
                                })
                              }
                            }}
                          >
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={canDefault() && defaultUrl() === i}>
                          <DropdownMenu.Item
                            onSelect={async () => {
                              try {
                                await platform.setDefaultServerUrl?.(null)
                                defaultUrlActions.mutate(null)
                              } catch (err) {
                                showToast({
                                  variant: "error",
                                  title: language.t("common.requestFailed"),
                                  description: err instanceof Error ? err.message : String(err),
                                })
                              }
                            }}
                          >
                            <DropdownMenu.ItemLabel>
                              {language.t("dialog.server.menu.defaultRemove")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          onSelect={() => handleRemove(i)}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>
            )
          }}
        </List>

        <Show when={platform.ssh} keyed>
          {(ssh) => <SSHSection ssh={ssh} onClose={() => dialog.close()} />}
        </Show>

        <Show when={!store.addServer.showForm}>
          <div class="server-dialog__footer">
            <Button
              variant="ghost"
              icon="plus-small"
              size="normal"
              onClick={() => {
                resetEdit()
                setStore("addServer", { showForm: true, url: "", error: "", status: undefined })
                scrollListToBottom()
              }}
              class="server-dialog__add-button"
            >
              {language.t("dialog.server.add.button")}
            </Button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
