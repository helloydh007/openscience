import { afterEach, beforeEach, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"

// The models.dev catalog builds lazily: most providers stay as stubs
// (`models: {}`) until something can connect them, and only candidates get the
// expensive full Info up front. These tests pin the promotion paths so a lazy
// build never hands a surviving provider an empty model list, and never
// rebuilds over a config-extended entry.

beforeEach(() => Provider.invalidate())
afterEach(() => Provider.invalidate())

test("an env-key connected catalog provider keeps its full catalog models", async () => {
  // cohere is reachable only through its env var — it is neither a custom
  // loader key nor a synthesis base, so its full Info exists only because the
  // env hit promotes the stub through mergeProvider.
  await using project = await tmpdir()
  try {
    const providers = await Instance.provide({
      directory: project.path,
      fn: () => {
        Env.set("COHERE_API_KEY", "cohere-lazy-catalog-probe")
        return Provider.list()
      },
    })
    // A stub merge base would leave zero models and the empty-models gate
    // would drop the provider entirely.
    const cohere = providers["cohere"]
    expect(cohere).toBeDefined()
    expect(cohere?.source).toBe("env")
    const model = cohere?.models["command-r7b-arabic-02-2025"]
    expect(model).toBeDefined()
    expect(model?.cost.input).toBeGreaterThan(0)
    expect(model?.limit.context).toBeGreaterThan(0)
    // A catalog sibling built in the same run is present too.
    expect(cohere?.models["command-r-08-2024"]).toBeDefined()
  } finally {
    delete process.env.COHERE_API_KEY
  }
})

test("config overrides extend a catalog provider without losing catalog models", async () => {
  await using project = await tmpdir({
    config: {
      provider: {
        xai: {
          models: {
            "grok-4.5": {
              name: "Renamed Grok",
              cost: { input: 9, output: 18 },
              limit: { context: 400_000, output: 64_000 },
            },
          },
        },
      },
    },
  })
  try {
    const providers = await Instance.provide({ directory: project.path, fn: () => Provider.list() })
    const xai = providers["xai"]
    expect(xai?.source).toBe("config")
    // The config override lands on the catalog model.
    expect(xai?.models["grok-4.5"]?.name).toBe("Renamed Grok")
    expect(xai?.models["grok-4.5"]?.cost.input).toBe(9)
    expect(xai?.models["grok-4.5"]?.limit.context).toBe(400_000)
    // Untouched catalog siblings survive: a lazy rebuild over the
    // config-extended entry would have dropped the override instead.
    expect(xai?.models["grok-4.3"]).toBeDefined()
    expect(xai?.models["grok-4.3"]?.cost.input).toBeGreaterThan(0)
  } finally {
    Provider.invalidate()
  }
})
