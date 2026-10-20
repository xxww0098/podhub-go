/** OCR completion contract: normalization, language, and charge-aware refusal copy. */
import assert from "node:assert/strict"
import test from "node:test"

import {
  AiResultUnusable,
  OCR_IMAGE_TAG_COUNT,
  mayRetryContract,
  parseAiCompletion,
} from "./ai-job"
import {
  answer,
  FIVE_TAGS,
  HAN_ANSWER,
  OK_ANSWER,
  TWENTY_TAGS,
} from "./executor-test-support"

test("Chinese in each answer field stays unusable and permits one correction", async () => {
  for (const [ru, desc, tags] of [
    ["Картина 山", "Сюжет.", FIVE_TAGS],
    ["Картина", "Сюжет 山.", FIVE_TAGS],
    ["Картина", "Сюжет.", ["#山", ...FIVE_TAGS.slice(1)]],
  ]) {
    await assert.rejects(() => parseAiCompletion(answer(JSON.stringify({ ru, desc, tags })), "m"), (error: unknown) => {
      assert.ok(error instanceof AiResultUnusable)
      assert.equal(error.contractKind, "corrective")
      assert.equal(mayRetryContract(error), true)
      assert.match(error.message, /混入了中文/)
      return true
    })
  }
})

test("the unusable-answer copy follows the actual charge", async () => {
  const invalid = answer(JSON.stringify({ ru: "Картина 山", desc: "Сюжет.", tags: FIVE_TAGS }))
  for (const chargedMicrofen of [0, 300]) {
    await assert.rejects(() => parseAiCompletion(invalid, "m", chargedMicrofen), (error: unknown) => {
      assert.ok(error instanceof AiResultUnusable)
      assert.match(error.message, chargedMicrofen > 0 ? /本次识别已计费/ : /本次未计费（预占已释放）/)
      if (chargedMicrofen === 0) assert.doesNotMatch(error.message, /已计费/)
      return true
    })
  }
})

test("Chinese contract failures retry, but an explicit permanent classification never does", () => {
  const reason = "商品描述中混入了中文，需要纯俄语内容"
  const cloudError = Object.assign(new Error(reason), { code: "cloud_ocr_contract_violation" })
  assert.equal(mayRetryContract(cloudError), true)
  assert.equal(mayRetryContract(new AiResultUnusable(reason, "permanent")), false)
  assert.equal(mayRetryContract(Object.assign(cloudError, { contractKind: "permanent" })), false)
})

test("a settled but unusable answer is refused rather than written to the Draft", async () => {
  await assert.rejects(() => parseAiCompletion(answer(JSON.stringify({ ru: "海报", tags: FIVE_TAGS, desc: "x" })), "m"), /俄语标题中混入了中文，需要纯俄语内容/)
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "Постер", tags: FIVE_TAGS, desc: "海报" })), "m"),
    /商品描述中混入了中文，需要纯俄语内容/,
  )
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "Постер", tags: ["#海", ...FIVE_TAGS.slice(1)], desc: "x" })), "m"),
    /商品标签中混入了中文，需要纯俄语内容/,
  )
  await assert.rejects(() => parseAiCompletion({ choices: [] }, "m"), /AI 没有返回识别内容/)
  await assert.rejects(() => parseAiCompletion(answer("not json"), "m"), /AI 返回的内容格式不正确/)
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "", tags: FIVE_TAGS, desc: "x" })), "m"),
    /AI 未生成俄语标题/,
  )
})

test("latin inside a russian title is kept and a latin tag is refused", async () => {
  const kept = await parseAiCompletion(answer(JSON.stringify({
    ru: "Чехол iPhone 17 Pro Max",
    tags: FIVE_TAGS,
    desc: "Сюжет.",
  })), "m")
  assert.equal(kept.ru, "Чехол iPhone 17 Pro Max")
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({
      ru: "Чехол",
      tags: ["#iPhone", ...FIVE_TAGS.slice(1)],
      desc: "Сюжет.",
    })), "m"),
    /俄语词或下划线标签/,
  )
})

test("tags require the strict five-tag Russian hashtag contract", async () => {
  const withTags = (tags: string[] | string) =>
    parseAiCompletion(answer(JSON.stringify({ ru: "Постер", tags, desc: "x" })), "m")
  const hashed = await withTags(["море", ...FIVE_TAGS.slice(1)])
  assert.equal(hashed.tags[0], "#море")
  assert.deepEqual(hashed.tags.slice(1), FIVE_TAGS.slice(1))
  const bare = await withTags(["лишний", ...FIVE_TAGS.slice(1)])
  assert.equal(bare.tags[0], "#лишний")
  const commas = await withTags("#горы, #озеро, #закат, #сосны, #отражение.")
  assert.deepEqual(commas.tags, ["#горы", "#озеро", "#закат", "#сосны", "#отражение"])
  const hyphen = await withTags(["чёрно-белый", ...FIVE_TAGS.slice(1)])
  assert.equal(hyphen.tags[0], "#чёрно_белый")
  assert.equal((await withTags(FIVE_TAGS)).tags.length, 5)
  const lengthOf = (tags: string[]) => withTags(tags).then((result) => result.tags.length)
  await assert.rejects(() => lengthOf(FIVE_TAGS.slice(0, 4)), /恰好 5 个商品标签/)
  await assert.rejects(() => lengthOf([...FIVE_TAGS, "#лишний"]), /恰好 5 个商品标签/)
  await assert.rejects(() => lengthOf([]), /恰好 5 个商品标签/)
  await assert.rejects(() => lengthOf([FIVE_TAGS[0]!.toLocaleUpperCase(), ...FIVE_TAGS.slice(1, 4), FIVE_TAGS[0]!]), /标签不能重复/)
  assert.equal((await withTags(FIVE_TAGS)).tags.length, OCR_IMAGE_TAG_COUNT)
})

test("latin inside a Cyrillic word is refused on title, description and tags; iPhone stays legal", async () => {
  const stuck = `кип${"i"}рис`
  assert.equal((await parseAiCompletion(answer(JSON.stringify({
    ru: "Чехол iPhone 17 Pro Max", tags: FIVE_TAGS, desc: "Чехол для iPhone 17 Pro Max.",
  })), "m")).ru, "Чехол iPhone 17 Pro Max")
  const folded = await parseAiCompletion(answer(JSON.stringify({ ru: "Чехол кипaрис", tags: FIVE_TAGS, desc: "Сюжет." })), "m")
  assert.equal(folded.ru, "Чехол кипарис")
  assert.equal(folded.ru.includes("a"), false)
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: `Чехол ${stuck}`, tags: FIVE_TAGS, desc: "Сюжет." })), "m"),
    /俄语标题里的俄语词混入了拉丁字母/,
  )
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "Чехол", tags: FIVE_TAGS, desc: `Сюжет ${stuck}.` })), "m"),
    /商品描述里的俄语词混入了拉丁字母/,
  )
  const mixedTags = [...FIVE_TAGS]
  mixedTags[0] = "#cipресс"
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "Чехол", tags: mixedTags, desc: "Сюжет." })), "m"),
    (error: unknown) => {
      assert.ok(error instanceof AiResultUnusable)
      assert.match(error.message, /商品标签里的俄语词混入了拉丁字母/)
      assert.equal(error.contractKind, "corrective")
      assert.equal(mayRetryContract(error), true)
      assert.doesNotMatch(error.message, /不会生成新答案/)
      return true
    },
  )
  await assert.rejects(() => parseAiCompletion(answer(HAN_ANSWER), "m"), (error: unknown) => {
    assert.ok(error instanceof AiResultUnusable)
    assert.equal(error.contractKind, "corrective")
    assert.equal(mayRetryContract(error), true)
    return true
  })
})

test("OCR title length counts Unicode scalars after trimming without truncation", async () => {
  const parseTitle = (ru: string) => parseAiCompletion(answer(JSON.stringify({ ru, tags: FIVE_TAGS, desc: "Сюжет." })), "m")
  for (const title of ["Ж".repeat(200), `${"Ж".repeat(199)}🦊`]) {
    assert.equal((await parseTitle(` \n${title}\t `)).ru, title)
    await assert.rejects(() => parseTitle(` \n${title}я\t `), /俄语标题不能超过 200 个字符/)
  }
})

test("the golden digital-painting answer passes as the Rust check does", async () => {
  const result = await parseAiCompletion(answer(OK_ANSWER), "qwen3.7-flash", 21_600)
  assert.match(result.ru, /^Картина по номерам на холсте 40х50 см без рамы "/)
  assert.equal(result.tags.length, OCR_IMAGE_TAG_COUNT)
  assert.ok(result.tags.every((tag) => tag.startsWith("#")))
  assert.equal(result.description.split(". ").length, 5)
})

test("fixed-tag jobs require exactly five image tags", async () => {
  await assert.rejects(
    () => parseAiCompletion(answer(JSON.stringify({ ru: "Постер", tags: TWENTY_TAGS.slice(0, 10), desc: "x" })), "m"),
    /恰好 5 个商品标签/,
  )
  const five = TWENTY_TAGS.slice(0, 5)
  assert.equal((await parseAiCompletion(answer(JSON.stringify({ ru: "Постер", tags: five, desc: "x" })), "m")).tags.length, 5)
})

test("a fenced answer with a space-separated tag string still parses", async () => {
  const wrapped = answer(`\`\`\`json\n{"ru":"Poster","tags":"${FIVE_TAGS.join(" ")}","desc":"Description"}\n\`\`\``)
  const result = await parseAiCompletion(wrapped, "gpt-x", 400)
  assert.deepEqual(result.tags, FIVE_TAGS)
  assert.equal(result.model, "gpt-x")
  assert.equal(result.cost_microfen, 400)
  assert.deepEqual(result.candidates, [])
})
