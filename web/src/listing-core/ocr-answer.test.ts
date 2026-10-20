import assert from "node:assert/strict"
import test from "node:test"

import { sharedListingCore } from "./client"
import { ListingCoreError } from "./wasm"

const FIVE = "#горы #озеро #закат #сосны #отражение"

function completion(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] }
}

test("parseOcrAnswer keeps Latin in a Russian title and refuses a Latin tag", async () => {
  const core = sharedListingCore()
  const kept = await core.parseOcrAnswer(completion(JSON.stringify({
    ru: "Чехол iPhone 17 Pro Max",
    tags: FIVE,
    desc: "Сюжет.",
  })))
  assert.equal(kept.ru, "Чехол iPhone 17 Pro Max")
  assert.equal(kept.description, "Сюжет.")
  assert.deepEqual(kept.tags, FIVE.split(" "))

  await assert.rejects(
    () => core.parseOcrAnswer(completion(JSON.stringify({
      ru: "Чехол",
      tags: FIVE.replace("#горы", "#iPhone"),
      desc: "Сюжет.",
    }))),
    (error: unknown) => {
      assert.ok(error instanceof ListingCoreError)
      assert.equal(error.code, "CORE_REFUSED")
      assert.equal(error.reasonCode, "configured_tags")
      assert.equal(error.retryClass, "corrective")
      assert.match(error.message, /俄语词或下划线标签/)
      return true
    },
  )
})

test("parseOcrAnswer canonicalizes search tags before it accepts them", async () => {
  const parsed = await sharedListingCore().parseOcrAnswer(completion(JSON.stringify({
    ru: "Чехол",
    tags: "#горы, #чёрно-белый. \"сосны\" #закат #отражение",
    desc: "Сюжет.",
  })))
  assert.deepEqual(parsed.tags, ["#горы", "#чёрно_белый", "#сосны", "#закат", "#отражение"])
})

test("parseOcrAnswer folds the completed lookalike map before validation", async () => {
  const ru = `Чехол r${"\u043e\u0440\u044b"} iPh\u043ene`
  const parsed = await sharedListingCore().parseOcrAnswer(completion(JSON.stringify({
    ru,
    tags: FIVE,
    desc: "Сюжет.",
  })))
  assert.equal(parsed.ru, "Чехол горы iPhone")
})

test("parseOcrAnswer folds lookalikes in every field before validation", async () => {
  const parsed = await sharedListingCore().parseOcrAnswer(completion(JSON.stringify({
    ru: "Чехол кипaрис для iPhone",
    tags: FIVE.replace("#озеро", "#озерo"),
    desc: "Сюжет кипaрис.",
  })))
  assert.equal(parsed.ru, "Чехол кипарис для iPhone")
  assert.equal(parsed.description, "Сюжет кипарис.")
  assert.deepEqual(parsed.tags, FIVE.split(" "))
})

test("parseOcrAnswer exposes the shared refusal reason and retry class", async () => {
  const valid = { ru: "Чехол", tags: FIVE, desc: "Сюжет." }
  const cases = [
    [{ choices: [] }, "no_text", "blind"],
    [completion("not json"), "not_json", "blind"],
    [completion(JSON.stringify({ ...valid, ru: "" })), "empty", "blind"],
    [completion(JSON.stringify({ ...valid, ru: "Ж".repeat(201) })), "title_too_long", "blind"],
    [completion(JSON.stringify({ ...valid, ru: "Чехол 山" })), "han", "corrective"],
    [completion(JSON.stringify({ ...valid, ru: "Чехол кипiрис" })), "mixed_script", "corrective"],
    [completion(JSON.stringify({ ...valid, desc: "Сюжет кипiрис." })), "mixed_script", "corrective"],
    [completion(JSON.stringify({ ...valid, tags: FIVE.replace("#горы", "#cipресс") })), "mixed_script", "corrective"],
  ] as const
  for (const [input, reasonCode, retryClass] of cases) {
    await assert.rejects(() => sharedListingCore().parseOcrAnswer(input), (error: unknown) => {
      assert.ok(error instanceof ListingCoreError)
      assert.equal(error.code, "CORE_REFUSED")
      assert.equal(error.reasonCode, reasonCode)
      assert.equal(error.retryClass, retryClass)
      return true
    })
  }
})
