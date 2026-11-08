import { createHash } from "node:crypto"
import type { LanguageModelUsage, ProviderMetadata } from "ai"
import type { MessageV2 } from "./message-v2"

/**
 * Local-first build: session-trace upload was removed together with the
 * Synthetic Sciences account it authenticated against.
 *
 * This module keeps the observation helpers the runtime still uses locally
 * (`reported` normalizes provider usage; `telemetrySessionID` names a local
 * audit record) but every recording and delivery entry point is a no-op, so no
 * prompt, model output, tool input or usage record can leave this machine
 * through telemetry. Model requests to the provider the user configured are
 * untouched.
 */
export namespace UsageLogging {
  export type Context = {
    session: { user_id: string; api_key: string; organization_id?: string }
    revision: number
    base: string
    account: string
  }
  export type Binding = {
    context: Context
    sessionID: string
    messageID: string
    route: string
    provider: string
    model: string
    operationID?: string
  }

  function digest(value: string) {
    return createHash("sha256").update(value).digest("hex")
  }

  function count(value: unknown) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  export async function bind(_input: Binding) {}
  export function unbind(_sessionID: string, _messageID: string) {}
  export async function part(_part: MessageV2.Part) {}

  /** Retain only numeric provider usage. Missing usage is unknown, never an
   * invented zero or a count estimated from the generated text. */
  export function reported(usage: LanguageModelUsage, metadata?: ProviderMetadata, provider?: string) {
    const cost = object(metadata?.openrouter?.usage).cost
    const price = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null
    return {
      usage_source: "provider_response" as const,
      usage: {
        input_tokens: count(usage.inputTokens),
        output_tokens: count(usage.outputTokens),
        total_tokens: count(usage.totalTokens),
        reasoning_tokens: count(usage.reasoningTokens),
        cached_input_tokens: count(usage.cachedInputTokens),
        cache_creation_input_tokens: count(
          metadata?.anthropic?.cacheCreationInputTokens ??
            object(metadata?.bedrock?.usage).cacheWriteInputTokens ??
            object(metadata?.venice?.usage).cacheCreationInputTokens ??
            object(object(metadata?.openrouter?.usage).promptTokensDetails).cacheWriteTokens ??
            metadata?.openai?.cacheCreationInputTokens ??
            metadata?.azure?.cacheCreationInputTokens ??
            (provider ? object(metadata?.[provider]).cacheCreationInputTokens : undefined),
        ),
      },
      cost_usd: price,
      cost_source: price === null ? ("unavailable" as const) : ("provider_response" as const),
    }
  }

  /** No account session exists in a local-first build, so no telemetry context
   * is ever produced and every caller that gates on it short-circuits. */
  export async function context(): Promise<Context | undefined> {
    return undefined
  }

  export async function installationID(): Promise<string> {
    return "local"
  }

  /** Opaque local identity for audit records; never transmitted. */
  export async function telemetrySessionID(sessionID: string) {
    return digest(`local:${sessionID}`)
  }

  export async function record(
    _input: Binding & {
      usage: LanguageModelUsage
      metadata?: ProviderMetadata
      duration: number
      content?: unknown
      finish?: string
      call?: { id: string; hold?: string; providerRequest?: string }
    },
  ) {}

  export async function event(_input: Binding, _kind: string, _payload: Record<string, unknown>) {}

  export const Status = {
    parse(value: unknown) {
      return value
    },
  }

  export async function status() {
    return {
      enabled: false,
      signedIn: false,
      queued: 0,
      quarantined: 0,
      delivered: 0,
      stalled: false,
    }
  }

  export async function setEnabled(_enabled: boolean) {
    return status()
  }

  export function flush(): Promise<void> {
    return Promise.resolve()
  }

  export function start() {}

  export async function drain() {}
}
