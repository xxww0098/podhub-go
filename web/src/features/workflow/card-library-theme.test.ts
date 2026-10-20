import assert from "node:assert/strict"
import test from "node:test"

import type { CategorySchemaView, ListingCardSummary } from "@/bindings/commands"
import { scheduleThemeProbes, THEME_PROBE_LIMIT } from "./card-library-theme"

function card(typeId: number): ListingCardSummary {
  return {
    draft_id: `card-${typeId}`,
    display_name: "方案",
    description_category_id: 11,
    type_id: typeId,
    language: "zh_hans",
    size: "",
    ai_prompt_file_name: "",
    psd_template_file_name: "",
    target_store_id: "",
    video_count: 0,
    updated_at_ms: 1,
  }
}

const schema = { fields: [] } as unknown as CategorySchemaView

function flushTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

test("cancelling before the timer does not load schemas or mark coordinates", async () => {
  const checked = new Set<string>()
  let calls = 0
  const cancel = scheduleThemeProbes({
    forms: [card(1), card(2)],
    checked,
    load: async () => {
      calls += 1
      return schema
    },
    onResult: () => undefined,
  })
  cancel()
  await flushTimers()
  assert.equal(calls, 0)
  assert.equal(checked.size, 0)
})

test("theme probes start after paint and stay within the concurrency cap", async () => {
  const checked = new Set<string>()
  const forms = Array.from({ length: THEME_PROBE_LIMIT + 2 }, (_, index) => card(index + 1))
  let started = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const results: Array<boolean | null> = []
  scheduleThemeProbes({
    forms,
    checked,
    load: async () => {
      started += 1
      await gate
      return schema
    },
    onResult: (_coordinate, supported) => {
      results.push(supported)
    },
  })
  assert.equal(started, 0)
  await flushTimers()
  assert.equal(started, THEME_PROBE_LIMIT)
  assert.equal(checked.size, forms.length)
  release()
  await flushTimers()
  await flushTimers()
  assert.equal(started, forms.length)
  assert.equal(results.length, forms.length)
  assert.ok(results.every((supported) => supported === false))
})
