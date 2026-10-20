import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import {
  FIELD_LAYER_ORDER,
  LAYER_LABEL,
  overriddenByCopy,
  sourceMarker,
  type FieldLayerView,
} from "./field-source"

const ALL_LAYERS = Object.keys(LAYER_LABEL) as FieldLayerView[]

test("every wire layer has a complete marker", () => {
  const wire: FieldLayerView[] = [
    "database_default",
    "seller_sku",
    "instance",
    "user_custom",
    "ocr",
    "source_file",
    "renderer",
    "system_default",
  ]
  assert.deepEqual([...ALL_LAYERS].sort(), [...wire].sort())
  for (const layer of ALL_LAYERS) {
    const marker = sourceMarker(layer)
    assert.ok(marker.icon, `${layer} has an icon`)
    assert.ok(marker.label, `${layer} has a label`)
    assert.match(marker.tone, /^text-[a-z-]+$/, `${layer} uses a semantic tone token`)
    assert.ok(!marker.overriddenBy.includes(layer), `${layer} does not override itself`)
  }
})

test("the local order is exactly the wire tuple", () => {
  // The schema tuple, spelled out so a wire change breaks this test loudly.
  const wire: components["schemas"]["FIELD_LAYER_ORDER"] = [
    "database_default",
    "instance",
    "seller_sku",
    "user_custom",
    "ocr",
    "source_file",
    "renderer",
    "system_default",
  ]
  assert.deepEqual([...FIELD_LAYER_ORDER], [...wire])
})

test("overriddenBy follows the write rules and the wire order", () => {
  const snapshot: Record<FieldLayerView, FieldLayerView[]> = {
    database_default: ["instance", "seller_sku", "user_custom", "ocr"],
    instance: ["seller_sku", "user_custom", "ocr"],
    seller_sku: ["user_custom", "ocr"],
    user_custom: ["ocr"],
    ocr: ["user_custom"],
    source_file: ["user_custom", "ocr"],
    renderer: ["user_custom"],
    system_default: ["user_custom"],
  }
  const index = new Map(FIELD_LAYER_ORDER.map((layer, position) => [layer, position]))
  for (const layer of ALL_LAYERS) {
    const overriders = sourceMarker(layer).overriddenBy
    assert.deepEqual([...overriders], snapshot[layer], `${layer} write rules`)
    for (let position = 1; position < overriders.length; position += 1) {
      assert.ok(
        (index.get(overriders[position - 1]!) ?? 0) < (index.get(overriders[position]!) ?? 0),
        `${layer} overriders are in wire order`,
      )
    }
  }
})

test("the tooltip copy names the layers or the final writer", () => {
  assert.equal(
    overriddenByCopy(sourceMarker("database_default")),
    "可被 实例、卖家货号、用户自定义、AI 识别 覆盖",
  )
  assert.equal(overriddenByCopy(sourceMarker("ocr")), "可被 用户自定义 覆盖")
  // renderer only fills open slots: a later operator write is the single way out.
  assert.equal(overriddenByCopy(sourceMarker("renderer")), "可被 用户自定义 覆盖")
})
