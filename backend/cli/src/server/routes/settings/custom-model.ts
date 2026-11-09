import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { parse } from "jsonc-parser"
import { McpUrl } from "@synsci/util/mcp-url"
import { Auth } from "../../../auth"
import { Config } from "../../../config/config"
import { CredentialLifecycle } from "../../../credentials/lifecycle"
import { Provider } from "../../../provider/provider"

/**
 * Bring-your-own-endpoint support: register an arbitrary OpenAI-compatible
 * model and ask that exact endpoint whether it is reachable.
 *
 * The verification request goes only to the URL the user typed. There is no
 * fallback host and no third-party relay.
 */

const ProviderID = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and dashes.")

const BaseURL = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !McpUrl.networkProblem(url, "Base URL", true) &&
      !url.search &&
      !url.hash &&
      !/\/(?:responses|chat\/completions|models|messages)\/?$/.test(url.pathname)
    )
  }, "Enter an HTTP(S) API base URL without credentials, query, fragment, or a request endpoint.")

const Verify = z.object({
  /** Optional provider id. OpenCode Go uses it to pick a probe model when the
   * form has no model id, so Test connection validates the key instead of the
   * provider's public model list. */
  providerID: z.string().trim().min(1).max(80).optional(),
  baseURL: BaseURL,
  apiKey: z.string().trim().min(1).optional(),
  modelID: z.string().trim().min(1).max(200).optional(),
})

const Save = Verify.extend({
  providerID: ProviderID,
  modelID: z.string().trim().min(1).max(200),
  modelName: z.string().trim().max(200).optional(),
  contextLimit: z.number().int().positive().max(4_000_000).optional(),
  outputLimit: z.number().int().positive().max(1_000_000).optional(),
})

const Result = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  modelFound: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  error: z.string().optional(),
})

function normalize(baseURL: string) {
  return baseURL.trim().replace(/\/+$/, "")
}

function headers(apiKey?: string) {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    Accept: "application/json",
  }
}

function modelIDs(body: unknown): string[] {
  if (body === null || typeof body !== "object") return []
  const record = body as Record<string, unknown>
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  return rows.flatMap((row) => {
    if (typeof row === "string") return [row]
    if (row !== null && typeof row === "object" && typeof (row as { id?: unknown }).id === "string")
      return [(row as { id: string }).id]
    if (row !== null && typeof row === "object" && typeof (row as { name?: unknown }).name === "string")
      return [(row as { name: string }).name]
    return []
  })
}

async function summary(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  const value = text.replace(/\s+/g, " ").trim()
  return value.length > 240 ? `${value.slice(0, 240)}…` : value
}

async function verify(input: z.infer<typeof Verify>): Promise<z.infer<typeof Result>> {
  const base = normalize(input.baseURL)
  const auth = headers(input.apiKey)

  const list = await fetch(`${base}/models`, {
    headers: auth,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (list && (list.status === 401 || list.status === 403)) {
    const detail = await summary(list)
    return { ok: false, status: list.status, error: `Authentication was rejected${detail ? `: ${detail}` : "."}` }
  }
  const ids = list?.ok ? modelIDs(await list.json().catch(() => undefined)) : []

  // A completion is the only honest check of a key: several providers serve
  // GET /models publicly, so a 200 there proves connectivity but not auth.
  // Probe with the requested model, or with the first listed model for an
  // OpenCode Go key when the form has no model id.
  const probeModel =
    input.modelID ?? (list?.ok && input.apiKey && input.providerID === "opencode-go" ? ids[0] : undefined)
  if (probeModel) {
    const chat = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (chat?.ok) {
      return {
        ok: true,
        status: chat.status,
        modelFound: true,
        ...(ids.length ? { models: ids.slice(0, 200) } : {}),
      }
    }
    if (chat) {
      const detail = await summary(chat)
      if (chat.status === 401 || chat.status === 403) {
        return { ok: false, status: chat.status, error: `Authentication was rejected${detail ? `: ${detail}` : "."}` }
      }
      // Some compatible servers expose /models but do not implement chat
      // completions. Only then is the list allowed to stand in.
      if (![404, 405].includes(chat.status) || !list?.ok) {
        return {
          ok: false,
          status: chat.status,
          modelFound: chat.status === 404 ? false : undefined,
          ...(ids.length ? { models: ids.slice(0, 200) } : {}),
          error: `The endpoint answered HTTP ${chat.status}${detail ? `: ${detail}` : "."}`,
        }
      }
    }
  }

  if (list?.ok) {
    if (input.modelID && ids.length > 0 && !ids.includes(input.modelID)) {
      return {
        ok: false,
        status: list.status,
        modelFound: false,
        models: ids.slice(0, 200),
        error: `The endpoint lists ${ids.length} models, but not "${input.modelID}".`,
      }
    }
    return {
      ok: true,
      status: list.status,
      ...(ids.length ? { models: ids.slice(0, 200) } : {}),
    }
  }

  const status = list?.status
  const detail = list ? await summary(list) : ""
  return {
    ok: false,
    status,
    error: status
      ? `The endpoint answered HTTP ${status}${detail ? `: ${detail}` : "."}`
      : "The endpoint did not answer.",
  }
}

export function CustomModelRoutes() {
  return new Hono()
    .post(
      "/verify",
      describeRoute({
        summary: "Verify a custom model endpoint",
        description: "Send a read-only probe to the exact base URL the user entered.",
        operationId: "settings.customModel.verify",
        responses: { 200: { description: "Verification result", content: { "application/json": { schema: resolver(Result) } } } },
      }),
      validator("json", Verify),
      async (c) => c.json(await verify(c.req.valid("json"))),
    )
    .post(
      "/",
      describeRoute({
        summary: "Save a custom OpenAI-compatible model",
        operationId: "settings.customModel.save",
        responses: { 200: { description: "Saved provider and model", content: { "application/json": { schema: resolver(z.boolean()) } } } },
      }),
      validator("json", Save),
      async (c) => {
        const input = c.req.valid("json")
        const providerID = input.providerID
        const base = normalize(input.baseURL)
        const saved = await CredentialLifecycle.serialized(async () => {
          const previous = Config.Info.parse(parse((await Config.getGlobalRaw()).content)).provider?.[providerID]
          const credential = await Auth.get(providerID)
          const limit = {
            context: input.contextLimit ?? previous?.models?.[input.modelID]?.limit?.context ?? 128_000,
            output: input.outputLimit ?? previous?.models?.[input.modelID]?.limit?.output ?? 8_192,
          }
          const models = {
            ...(previous?.models ?? {}),
            [input.modelID]: {
              ...(previous?.models?.[input.modelID] ?? {}),
              id: input.modelID,
              name: input.modelName || previous?.models?.[input.modelID]?.name || input.modelID,
              tool_call: previous?.models?.[input.modelID]?.tool_call ?? true,
              limit,
            },
          }
          const next = {
            ...previous,
            name: previous?.name ?? providerID,
            npm: previous?.npm ?? "@ai-sdk/openai-compatible",
            api: base,
            ...(previous?.env ? { env: previous.env } : {}),
            options: {
              ...previous?.options,
              baseURL: base,
              // A keyless custom endpoint is valid (some local gateways);
              // requiring a credential here would delete the provider again.
              requiresCredential: input.apiKey ? true : false,
            },
            models,
          }
          try {
            if (input.apiKey) await Auth.set(providerID, { type: "api", key: input.apiKey })
            await Config.setProvider(providerID, next)
          } catch (cause) {
            const restored = await Promise.allSettled([
              previous ? Config.setProvider(providerID, previous) : Config.removeProvider(providerID),
              credential ? Auth.set(providerID, credential) : Auth.remove(providerID),
            ])
            const failures = restored.filter((item) => item.status === "rejected").map((item) => (item as PromiseRejectedResult).reason)
            if (failures.length)
              throw new AggregateError(
                [cause, ...failures],
                "The custom model could not be saved or fully restored. Review Models before retrying.",
              )
            throw cause
          }
          return true
        })
        Provider.invalidate()
        return c.json(saved)
      },
    )
}
