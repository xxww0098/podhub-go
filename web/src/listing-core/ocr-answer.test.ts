import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { sharedListingCore } from "./client"
import { ListingCoreError } from "./wasm"
import type { OcrAnswerInput } from "./types"

test("browser WASM rejects 51 retired theme-only replies instead of inventing five tags", async () => {
  const cases = JSON.parse(readFileSync(new URL("../../../rust/crates/listing-core/tests/fixtures/ocr-qwen-live-20261030.json",import.meta.url),"utf8")) as (OcrAnswerInput & {expected_reason:string|null;expected_title:string|null})[]
  assert.equal(cases.length,51)
  for (const c of cases) {
    const input = { profile:c.profile,fixed_tags:c.fixed_tags,completion:c.completion }
    await assert.rejects(() => sharedListingCore().parseOcrAnswer(input),(err:unknown) => {
      assert.ok(err instanceof ListingCoreError)
      assert.equal(err.reasonCode,"invalid_theme_json")
      assert.equal(err.retryClass,"permanent")
      return true
    })
  }
})

test("free formula preview validates a title without fabricating model descriptions or tags", async () => {
  const profile = { product_type_ru: "Кружка", facts_ru: "330 мл" }
  const answer = await sharedListingCore().parseOcrAnswer({ profile, fixed_tags: ["#кружка"], preview_theme: "Кот с чашкой" })
  assert.equal(answer.ru, 'Кружка 330 мл "Кот с чашкой"')
  assert.deepEqual(answer.tags, [])
  assert.equal(answer.description, "Кружка 330 мл")
  await assert.rejects(() => sharedListingCore().parseOcrAnswer({ profile, fixed_tags: ["#кружка"], preview_theme: "Кот 山" }))
})

test("browser WASM replays real descriptions and five image tags with the server's assembly rules", async () => {
  const cases = JSON.parse(readFileSync(new URL("../../../rust/crates/listing-core/tests/fixtures/ocr-qwen-live-20261103.json",import.meta.url),"utf8")) as (OcrAnswerInput & {
    expected_title: string; expected_description: string; expected_tags: string[]; expected_combined_tags: string[]
  })[]
  assert.equal(cases.length, 3)
  for (const c of cases) {
    const answer = await sharedListingCore().parseOcrAnswer({ profile: c.profile, fixed_tags: c.fixed_tags, completion: c.completion })
    assert.equal(answer.ru, c.expected_title)
    assert.equal(answer.description, c.expected_description)
    assert.deepEqual(answer.tags, c.expected_tags)
    assert.equal(answer.tags.length, 5)
    assert.deepEqual([...c.fixed_tags, ...answer.tags], c.expected_combined_tags)
  }
})
