import { McpUrl } from "@synsci/util/mcp-url"
import { For, Show, createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { Select } from "@synsci/ui/select"
import type { Provider } from "@synsci/sdk/v2/client"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import type { dict } from "@/i18n/en"
import { MODEL_PROVIDERS, MODEL_PROVIDER_LABELS, modelProvider } from "./model-providers"
import { settingsApi } from "./api"
import { ProviderLogo } from "./ProviderLogo"
import { Icon } from "@synsci/ui/icon"

/**
 * `note` says where a key that this panel cannot delete actually lives, so the
 * reader knows where to go and change it. Every non-removable source used to
 * render one blanket "external", which is wrong for a key the user
 * set themselves in a .env or a config file — nobody else manages it, and the
 * phrase suggests an administrator does.
 */
type ProviderSource = Provider["source"] | "managed"
type Copy = keyof typeof dict

const SOURCES: Record<ProviderSource, { label: Copy; removable: boolean; title: Copy; note?: Copy }> = {
  api: {
    label: "settings.providerKeys.source.api.label",
    removable: true,
    title: "settings.providerKeys.source.api.title",
  },
  env: {
    label: "settings.providerKeys.source.env.label",
    removable: false,
    note: "settings.providerKeys.source.env.note",
    title: "settings.providerKeys.source.env.title",
  },
  config: {
    label: "settings.providerKeys.source.config.label",
    removable: false,
    note: "settings.providerKeys.source.config.note",
    title: "settings.providerKeys.source.config.title",
  },
  custom: {
    label: "settings.providerKeys.source.custom.label",
    removable: false,
    note: "settings.providerKeys.source.config.note",
    title: "settings.providerKeys.source.custom.title",
  },
  workspace: {
    label: "settings.providerKeys.source.workspace.label",
    removable: false,
    note: "settings.providerKeys.source.workspace.note",
    title: "settings.providerKeys.source.workspace.title",
  },
  managed: {
    label: "settings.providerKeys.source.managed.label",
    removable: false,
    note: "settings.providerKeys.source.managed.note",
    title: "settings.providerKeys.source.managed.title",
  },
}

export function ProviderKeys(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const providers = useProviders()
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const [form, setForm] = createStore({
    provider: MODEL_PROVIDERS[0].id as string,
    key: "",
    adding: false,
    saving: false,
    verifying: false,
    baseURL: modelProvider(MODEL_PROVIDERS[0].id).baseURL ?? "",
    api: "responses" as "responses" | "chat",
    modelOpen: false,
    modelID: "",
    modelName: "",
    customProviderID: "",
    verify: undefined as { ok: boolean; message: string } | undefined,
  })
  const selectProvider = (id: string) => {
    const options = sync.data.config.provider?.[id]?.options
    setForm({
      provider: id,
      key: "",
      baseURL: options?.baseURL ?? modelProvider(id).baseURL ?? "",
      api: options?.api === "chat" ? "chat" : "responses",
      verify: undefined,
      modelID: "",
      modelName: "",
    })
  }
  const modelID = () => form.modelID.trim()
  const baseURL = () => form.baseURL.trim().replace(/\/+$/, "")
  const customProviderID = () => {
    const manual = form.customProviderID.trim().toLowerCase()
    if (manual) return manual
    // Derive a stable provider id from the endpoint host so a brand-new
    // endpoint needs no extra naming step.
    try {
      const host = new URL(baseURL()).hostname.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      return host ? `custom-${host}`.slice(0, 80) : ""
    } catch {
      return ""
    }
  }
  const effectiveProvider = () => (form.provider === "custom" ? customProviderID() : form.provider)
  const verify = async () => {
    if (!baseURL() || form.verifying) return
    setForm("verifying", true)
    setForm("verify", undefined)
    try {
      const result = await settingsApi<{
        ok: boolean
        status?: number
        modelFound?: boolean
        models?: string[]
        error?: string
      }>(sdk.url, fetchFn, "/settings/custom-model/verify", {
        method: "POST",
        body: JSON.stringify({
          providerID: effectiveProvider(),
          baseURL: baseURL(),
          ...(form.key.trim() ? { apiKey: form.key.trim() } : {}),
          ...(modelID() ? { modelID: modelID() } : {}),
        }),
      })
      if (result.ok) {
        setForm("verify", {
          ok: true,
          message: modelID()
            ? `Connected · model "${modelID()}" is available`
            : form.key.trim()
              ? "Connected · key accepted"
              : "Connected · endpoint answered",
        })
      } else {
        setForm("verify", {
          ok: false,
          message: result.error ?? `Connection failed${result.status ? ` (HTTP ${result.status})` : ""}`,
        })
      }
    } catch (error) {
      setForm("verify", { ok: false, message: reason(error) })
    } finally {
      setForm("verifying", false)
    }
  }
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const connected = createMemo(() => providers.connected().filter((item) => item.source !== "managed"))
  const source = (item: { id: string; source?: ProviderSource }) => SOURCES[item.source ?? "api"]
  const refreshAfterSave = (
    failed: "settings.providerKeys.saved.reloadFailed" | "settings.providerKeys.removed.reloadFailed",
  ) => {
    void sync.refreshProviders().catch((error) => props.onError?.(language.t(failed, { reason: reason(error) })))
  }
  const save = async () => {
    const value = form.key.trim()
    if (form.saving) return
    // A local or keyless OpenAI-compatible endpoint is valid as long as the
    // model id and base URL are present.
    if (!value && !(modelID() && baseURL())) return
    // An Ace key is a Wallet credential, not a provider key: say where it goes
    // instead of letting the server's refusal explain it.
    if (/^(?:osk_|thk_|thk-)/.test(value)) {
      props.onError?.(language.t("settings.providerKeys.aceKey"))
      return
    }
    if (form.baseURL.trim()) {
      const url = URL.canParse(form.baseURL.trim()) ? new URL(form.baseURL.trim()) : undefined
      if (
        !url ||
        McpUrl.networkProblem(url, "Base URL", true) ||
        url.search ||
        url.hash ||
        /\/(?:responses|chat\/completions|messages)\/?$/.test(url.pathname)
      ) {
        props.onError?.(language.t("settings.providerKeys.invalidURL"))
        return
      }
    }
    if (modelID() && !baseURL()) {
      props.onError?.("Enter the model's API base URL before saving a custom model.")
      return
    }
    if (modelID() && !/^[a-z0-9][a-z0-9-]*$/.test(effectiveProvider())) {
      props.onError?.("Enter a provider id using lowercase letters, digits and dashes.")
      return
    }
    setForm("saving", true)
    props.onError?.(undefined)
    try {
      if (modelID()) {
        await settingsApi<boolean>(sdk.url, fetchFn, "/settings/custom-model", {
          method: "POST",
          body: JSON.stringify({
            providerID: effectiveProvider(),
            baseURL: baseURL(),
            modelID: modelID(),
            ...(form.modelName.trim() ? { modelName: form.modelName.trim() } : {}),
            ...(value ? { apiKey: value } : {}),
          }),
        })
      } else {
        await sdk.client.auth.connection({
          providerID: form.provider,
          key: value,
          baseURL: form.baseURL,
          api: form.api,
        })
      }
      sync.set(
        "config",
        produce((config) => {
          const id = modelID() ? effectiveProvider() : form.provider
          config.provider ??= {}
          config.provider[id] ??= {}
          const provider = config.provider[id]
          provider.options ??= {}
          const base = form.baseURL.trim().replace(/\/+$/, "")
          if (base) provider.options.baseURL = base
          else delete provider.options.baseURL
          if (id === "openai") provider.options.api = form.api
          if (modelID()) {
            provider.models ??= {}
            provider.models[modelID()] = {
              ...(provider.models[modelID()] ?? {}),
              id: modelID(),
              name: form.modelName.trim() || modelID(),
              tool_call: true,
            }
          }
        }),
      )
      setForm("key", "")
      setForm("adding", false)
      // The credential is on disk now. Re-enable the form before rebuilding
      // the large provider catalog; auth.connection already invalidates the server's
      // provider map, so disposing every workspace here only added latency.
      setForm("saving", false)
      refreshAfterSave("settings.providerKeys.saved.reloadFailed")
    } catch (error) {
      props.onError?.(language.t("settings.providerKeys.saveFailed"))
    } finally {
      setForm("saving", false)
    }
  }

  const remove = async (providerID: string) => {
    if (form.saving) return
    const label = MODEL_PROVIDER_LABELS[providerID] ?? providerID
    const confirmed = await confirmDialog(dialog, {
      cancelLabel: language.t("common.cancel"),
      title: language.t("settings.providerKeys.remove.title", { provider: label }),
      message: language.t("settings.providerKeys.remove.message"),
      confirmLabel: language.t("settings.providerKeys.remove.confirm"),
      danger: true,
    })
    if (!confirmed) return
    setForm("saving", true)
    props.onError?.(undefined)
    try {
      await sdk.client.auth.remove({ providerID })
      setForm("saving", false)
      refreshAfterSave("settings.providerKeys.removed.reloadFailed")
    } catch (error) {
      props.onError?.(reason(error))
    } finally {
      setForm("saving", false)
    }
  }

  return (
    <div class="models-provider-keys">
      <div class="settings-row models-compact-row models-provider-key-heading">
        <div class="models-provider-identity">
          <span class="settings-row-logo" aria-hidden="true">
            <Icon name="providers" size="small" />
          </span>
          <div class="models-provider-copy">
            <span class="text-14-medium text-text-strong">{language.t("settings.providerKeys.title")}</span>
            <span class="text-12-regular text-text-weak">{language.t("settings.providerKeys.description")}</span>
          </div>
        </div>
        <span class="models-row-action">
          <Button
            class="settings-panel-action models-secondary-action"
            type="button"
            size="small"
            variant="secondary"
            aria-expanded={form.adding}
            aria-controls="models-add-provider-key"
            disabled={form.saving}
            onClick={() => {
              if (form.adding) setForm("key", "")
              else selectProvider(form.provider)
              setForm("adding", (open) => !open)
            }}
          >
            {form.adding ? language.t("common.cancel") : language.t("settings.providerKeys.add")}
          </Button>
        </span>
      </div>

      <Show when={form.adding}>
        <form
          id="models-add-provider-key"
          class="settings-provider-key-form models-provider-key-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">{language.t("settings.providerKeys.field.provider")}</span>
            <div class="models-provider-select">
              <Select
                aria-label={language.t("settings.providerKeys.field.provider.ariaLabel")}
                class="models-provider-options"
                options={[...MODEL_PROVIDERS]}
                current={modelProvider(form.provider)}
                value={(item) => item.id}
                label={(item) => item.label}
                disabled={form.saving}
                onSelect={(item) => item && selectProvider(item.id)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{
                  width: "100%",
                  "justify-content": "space-between",
                }}
              />
            </div>
          </label>
          <Show when={form.provider === "custom"}>
            <label class="models-key-field">
              <span class="text-12-medium text-text-weak">Provider ID</span>
              <input
                type="text"
                autocomplete="off"
                spellcheck={false}
                disabled={form.saving}
                value={form.customProviderID}
                onInput={(event) => setForm("customProviderID", event.currentTarget.value)}
                placeholder={customProviderID() || "my-endpoint"}
                class="settings-field models-key-input"
              />
              <span class="text-12-regular text-text-weak">
                Lowercase letters, digits and dashes. Leave blank to derive it from the base URL host.
              </span>
            </label>
          </Show>
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">{language.t("provider.connect.method.apiKey")}</span>
            <input
              type="password"
              autocomplete="off"
              spellcheck={false}
              disabled={form.saving}
              value={form.key}
              onInput={(event) => setForm("key", event.currentTarget.value)}
              placeholder={modelProvider(form.provider).placeholder}
              class="settings-field settings-provider-key models-key-input"
            />
          </label>
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">{language.t("settings.providerKeys.baseURL")}</span>
            <input
              type="url"
              autocomplete="off"
              spellcheck={false}
              disabled={form.saving}
              value={form.baseURL}
              onInput={(event) => setForm("baseURL", event.currentTarget.value)}
              placeholder={
                form.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.example.com/v1"
              }
              class="settings-field models-key-input"
            />
            <span class="text-12-regular text-text-weak">{language.t("settings.providerKeys.baseURL.help")}</span>
          </label>
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">Model ID · optional</span>
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              disabled={form.saving}
              value={form.modelID}
              onInput={(event) => {
                setForm("modelID", event.currentTarget.value)
                setForm("verify", undefined)
              }}
              placeholder={
                form.provider === "opencode-go" ? "deepseek-v4.1-flash" : "any model id your endpoint serves"
              }
              class="settings-field models-key-input"
            />
            <span class="text-12-regular text-text-weak">
              Use this to add a model that is not in the built-in list. A custom provider id is required for a brand-new
              endpoint; OpenCode Go models can be added directly.
            </span>
          </label>
          <label class="models-key-field">
            <span class="text-12-medium text-text-weak">Display name · optional</span>
            <input
              type="text"
              autocomplete="off"
              spellcheck={false}
              disabled={form.saving}
              value={form.modelName}
              onInput={(event) => setForm("modelName", event.currentTarget.value)}
              placeholder="Shown in the model picker"
              class="settings-field models-key-input"
            />
          </label>
          <div class="models-key-field">
            <Button
              class="settings-panel-action models-secondary-action"
              type="button"
              size="small"
              variant="secondary"
              disabled={form.verifying || !baseURL()}
              onClick={() => void verify()}
            >
              {form.verifying ? "Testing…" : "Test connection"}
            </Button>
            <Show when={form.verify}>
              {(result) => (
                <span
                  role="status"
                  class="text-12-regular"
                  classList={{ "text-text-strong": result().ok, "text-text-danger": !result().ok }}
                >
                  {result().message}
                </span>
              )}
            </Show>
            <span class="text-12-regular text-text-weak">
              Sends one request to the base URL above. No key or prompt leaves for any other host.
            </span>
          </div>
          <Show
            when={form.provider === "openai"}
            fallback={
              <span class="text-12-regular text-text-weak">
                {language.t(
                  form.provider === "anthropic"
                    ? "settings.providerKeys.anthropicProtocol"
                    : "settings.providerKeys.providerProtocol",
                )}
              </span>
            }
          >
            <label class="models-key-field">
              <span class="text-12-medium text-text-weak">{language.t("settings.providerKeys.protocol")}</span>
              <select
                class="settings-field models-key-input"
                value={form.api}
                disabled={form.saving}
                onChange={(event) => setForm("api", event.currentTarget.value === "chat" ? "chat" : "responses")}
              >
                <option value="responses">OpenAI Responses</option>
                <option value="chat">OpenAI Chat Completions</option>
              </select>
              <span class="text-12-regular text-text-weak">{language.t("settings.providerKeys.protocol.help")}</span>
            </label>
          </Show>
          <Button
            class="settings-panel-action models-primary-action models-save-key"
            type="submit"
            size="small"
            variant="primary"
            disabled={
              form.saving ||
              (form.provider === "custom" && !modelID()) ||
              (!form.key.trim() && !(modelID() && baseURL()))
            }
          >
            {form.saving ? language.t("settings.saving") : language.t("settings.providerKeys.save")}
          </Button>
        </form>
      </Show>

      <Show when={connected().length > 0}>
        <div class="models-connected-providers">
          <For each={connected()}>
            {(item) => (
              <div class="settings-row models-compact-row models-provider-row">
                <div class="models-provider-identity min-w-0 flex-1 basis-[220px]">
                  <span class="settings-row-logo" aria-hidden="true">
                    <ProviderLogo id={item.id} label={MODEL_PROVIDER_LABELS[item.id] ?? item.id} size="small" />
                  </span>
                  <div class="models-provider-copy">
                    <span class="truncate text-14-medium text-text-strong">
                      {MODEL_PROVIDER_LABELS[item.id] ?? item.id}
                    </span>
                    <div class="models-provider-meta">
                      <span class="models-provider-source" title={language.t(source(item).title)}>
                        {language.t(source(item).label)}
                      </span>
                    </div>
                  </div>
                </div>
                <span class="settings-row-status">{language.t("settings.providerKeys.status.available")}</span>
                <Show
                  when={source(item).removable}
                  fallback={
                    <span
                      class="models-provider-note text-12-regular text-text-weak"
                      title={language.t(source(item).title)}
                    >
                      {language.t(source(item).note ?? "settings.providerKeys.source.external")}
                    </span>
                  }
                >
                  <span class="models-row-action">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet models-secondary-action"
                      size="small"
                      variant="secondary"
                      disabled={form.saving}
                      onClick={() => void remove(item.id)}
                    >
                      {language.t("settings.providerKeys.remove")}
                    </Button>
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={connected().length === 0 && !form.adding}>
        <p class="models-provider-empty" role="status">
          {language.t("settings.providerKeys.empty")}
        </p>
      </Show>
    </div>
  )
}
