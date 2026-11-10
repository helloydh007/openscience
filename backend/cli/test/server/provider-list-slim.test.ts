import { describe, expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { ModelsDev } from "../../src/provider/models"
import { slimProviderResponse } from "../../src/server/routes/provider"

const catalogModel = (id: string): ModelsDev.Model => ({
  id,
  name: id,
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  options: {},
  limit: { context: 200000, output: 8192 },
})

const catalogProvider = (id: string, models: Record<string, ModelsDev.Model> = {}): ModelsDev.Provider => ({
  id,
  name: `Catalog ${id}`,
  env: ["CATALOG_ENV"],
  models,
})

// Provider.list hands back fully built Info entries, so the same builder
// keeps the connected fixture realistic.
const connectedInfo = (id: string) =>
  Provider.fromModelsDevProvider(catalogProvider(id, { [`${id}-model`]: catalogModel(`${id}-model`) }))

describe("slimProviderResponse", () => {
  test("directory providers are stubs without models", () => {
    const result = slimProviderResponse({ fixture: catalogProvider("fixture") }, {})
    expect(result.all).toEqual([
      {
        id: "fixture",
        source: "custom",
        name: "Catalog fixture",
        env: ["CATALOG_ENV"],
        options: {},
        models: {},
      },
    ])
    expect(Provider.Info.safeParse(result.all[0]).success).toBe(true)
    expect(result.connected).toEqual([])
    expect(result.default).toEqual({})
  })

  test("connected providers keep their full models and overlay the catalog stub", () => {
    const result = slimProviderResponse({ fixture: catalogProvider("fixture") }, { fixture: connectedInfo("fixture") })
    expect(result.all).toHaveLength(1)
    expect(Object.keys(result.all[0].models)).toEqual(["fixture-model"])
    expect(result.default).toEqual({ fixture: "fixture-model" })
    expect(result.connected).toEqual(["fixture"])
  })

  test("default only covers connected providers with models; stubs never do", () => {
    const result = slimProviderResponse(
      {
        cataloged: catalogProvider("cataloged", { "cataloged-model": catalogModel("cataloged-model") }),
        empty: catalogProvider("empty"),
      },
      { cataloged: connectedInfo("cataloged"), emptyConnected: Provider.fromModelsDevProvider(catalogProvider("emptyConnected")) },
    )
    expect(result.all).toHaveLength(3)
    expect(result.default).toEqual({ cataloged: "cataloged-model" })
    expect(result.connected).toEqual(["cataloged", "emptyConnected"])
  })

  test("providers with no models do not crash the default computation", () => {
    expect(() => slimProviderResponse({ a: catalogProvider("a"), b: catalogProvider("b") }, {})).not.toThrow()
    expect(slimProviderResponse({ a: catalogProvider("a"), b: catalogProvider("b") }, {}).default).toEqual({})
  })
})
