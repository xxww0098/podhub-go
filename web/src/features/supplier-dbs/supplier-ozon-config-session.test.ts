import assert from "node:assert/strict"
import test from "node:test"

import type { CategorySchemaView } from "@/bindings/commands"
import type {
  PutSupplierOzonConfigBody,
  SupplierOzonConfigData,
  SupplierOzonConfigIO,
} from "./supplier-ozon-config"
import { OzonConfigSession } from "./supplier-ozon-config-session"

const COORD = { descriptionCategoryId: 11, typeId: 101 }
function schema(): CategorySchemaView {
  return { description_category_id: 11, type_id: 101, language: "zh_hans", fields: [], complex_groups: [] }
}
// Session tests isolate identity/CAS; conversion coverage owns its richer schema.
function savedConfig(over: Partial<SupplierOzonConfigData> = {}): SupplierOzonConfigData {
  return { product_id: "p1", description_category_id: 11, type_id: 101, language: "zh_hans", values: {}, fixed_tags: [], prompt_text: "", ai_output: { title: true, description: true, tags: true }, revision: 4, state: "valid", issues: [], usable: false, updated_at_ms: 0, ...over }
}

// ---------- 会话：基线与身份随行 ----------

function recordingIO(over: Partial<SupplierOzonConfigIO> = {}) {
  const puts: { sourceId: string; productId: string; body: PutSupplierOzonConfigBody }[] =
    []
  const io: SupplierOzonConfigIO = {
    get: async () => undefined,
    put: async (sourceId, productId, body) => {
      puts.push({ sourceId, productId, body })
      return savedConfig({ revision: body.expected_revision + 1 })
    },
    ...over,
  }
  return { io, puts }
}

test("OzonConfigSession: 进行中的写只写自己的行、用自己的 CAS 基线", async () => {
  // 模拟换行时挂账仍在飞：会话 a 的 put 挂起，会话 b 已接管。
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { io, puts } = recordingIO({
    put: async (sourceId, productId, body) => {
      puts.push({ sourceId, productId, body })
      await gate
      return savedConfig({ product_id: productId, revision: body.expected_revision + 1 })
    },
  })
  const a = new OzonConfigSession("src-1", "p1", io, savedConfig({ product_id: "p1", revision: 7 }))
  const b = new OzonConfigSession("src-1", "p2", io, savedConfig({ product_id: "p2", revision: 3 }))
  const inflight = a.save(
    { values: { currency_code: { kind: "text", value: "RUB" } }, complex_values: [] },
    schema(),
    COORD,
  )
  a.disposed = true // 旧行已卸下：写仍落 p1、签 7
  release()
  await inflight
  await b.save(
    { values: { currency_code: { kind: "text", value: "USD" } }, complex_values: [] },
    schema(),
    COORD,
  )
  assert.equal(puts[0]?.productId, "p1")
  assert.equal(puts[0]?.body.expected_revision, 7)
  assert.equal(puts[1]?.productId, "p2")
  assert.equal(puts[1]?.body.expected_revision, 3)
  assert.equal(a.baseline?.revision, 8, "a 的基线只被 a 的保存推进")
  assert.equal(b.baseline?.revision, 4)
})

test("OzonConfigSession: 409 置 conflicted 不再自动续写，成功后复位", async () => {
  let reject = true
  const { io, puts } = recordingIO({
    put: async (sourceId, productId, body) => {
      puts.push({ sourceId, productId, body })
      if (reject) throw { code: "cloud_conflict" }
      return savedConfig({ product_id: productId, revision: body.expected_revision + 1 })
    },
  })
  const s = new OzonConfigSession("src-1", "p1", io, savedConfig({ revision: 7 }))
  await assert.rejects(() =>
    s.save({ values: {}, complex_values: [] }, schema(), COORD),
  )
  assert.equal(s.conflicted, true, "CAS 冲突打标：宿主据此锁回重新读取")
  assert.equal(s.baseline?.revision, 7, "冲突不刷基线 —— 不做静默最后写赢")

  s.baseline = savedConfig({ revision: 8 }) // 用户点「重新读取」后的新基线
  reject = false
  const saved = await s.save({ values: {}, complex_values: [] }, schema(), COORD)
  assert.equal(saved.revision, 9)
  assert.equal(s.conflicted, false)
})

test("OzonConfigSession: PUT 回带基线的 promptText/fixedTags/aiOutput/language，首个配置 expectedRevision 0", async () => {
  const { io, puts } = recordingIO()
  const s = new OzonConfigSession("src-1", "p1", io)
  await s.save(
    { values: { currency_code: { kind: "text", value: "RUB" } }, complex_values: [] },
    schema(),
    COORD,
  )
  assert.equal(puts[0]?.body.expected_revision, 0)
  assert.equal(puts[0]?.body.language, "zh_hans")
  assert.deepEqual(puts[0]?.body.ai_output, {
    title: true,
    description: true,
    tags: true,
  })

  const withBase = new OzonConfigSession(
    "src-1",
    "p1",
    io,
    savedConfig({
      revision: 5,
      prompt_text: "识别红白配色",
      fixed_tags: ["#a"],
      language: "ru",
    }),
  )
  await withBase.save({ values: {}, complex_values: [] }, schema(), COORD)
  const echo = puts[1]?.body
  assert.equal(echo?.expected_revision, 5)
  assert.equal(echo?.prompt_text, "识别红白配色")
  assert.deepEqual(echo?.fixed_tags, ["#a"])
  assert.equal(echo?.language, "ru")
})
test("explicit reload clears a deleted config baseline and conflict", async () => {
  const { io, puts } = recordingIO()
  const session = new OzonConfigSession("src-1", "p1", io, savedConfig({ revision: 7 }))
  session.conflicted = true
  await session.load()
  assert.equal(session.baseline, undefined)
  assert.equal(session.conflicted, false)
  await session.save({ values: {}, complex_values: [] }, schema(), COORD)
  assert.equal(puts[0]?.body.expected_revision, 0)
})

test("行版本变了且本地干净：重读基线，下一次写回签新 revision", async () => {
  // 行面板改了提示词：服务端配置 revision 4 → 5，本会话基线仍是 4。
  let server = savedConfig({ revision: 4, prompt_text: "旧" })
  const { io, puts } = recordingIO({ get: async () => server })
  const session = new OzonConfigSession("src-1", "p1", io, server)
  assert.equal(await session.followRowRevision(2, true), false, "首次只记版本")
  server = savedConfig({ revision: 5, prompt_text: "新" })
  assert.equal(await session.followRowRevision(3, false), false, "有挂账不重读")
  assert.equal(await session.followRowRevision(4, true), true)
  await session.save({ values: {}, complex_values: [] }, schema(), COORD)
  assert.equal(puts[0]?.body.expected_revision, 5)
  assert.equal(puts[0]?.body.prompt_text, "新", "不回写旧提示词")

  session.conflicted = true
  assert.equal(await session.followRowRevision(5, true), false, "冲突后不自动重读")
  assert.equal(session.conflicted, true)
})
