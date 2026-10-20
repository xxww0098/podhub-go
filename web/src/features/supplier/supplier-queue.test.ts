import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { queueFacts, SUPPLIER_PORTAL_POLL_MS } from "./supplier-board"
import { accountLabel, factorySubtitle } from "./supplier-queue"

test("右上角用账号名，没有名字时用邮箱", () => {
  assert.equal(accountLabel(" 浏览器绑定探针 ", "a@example.invalid"), "浏览器绑定探针")
  assert.equal(accountLabel("  ", "a@example.invalid"), "a@example.invalid")
  assert.equal(accountLabel(null, "  "), "")
})

test("排单页头标明这些是你的厂", () => {
  assert.equal(factorySubtitle([]), "")
  assert.equal(factorySubtitle(["  "]), "")
  assert.equal(factorySubtitle(["浏览器绑定探针"]), "你的厂：浏览器绑定探针")
  assert.equal(
    factorySubtitle(["浏览器绑定探针", " 浏览器绑定探针二 "]),
    "你的厂：浏览器绑定探针、浏览器绑定探针二",
  )
})

test("看板计数：已发货不计加急，在制金额不含已发货", () => {
  const now = Date.parse("2026-10-07T12:00:00Z")
  const facts = queueFacts(
    {
      pending: [
        { state: "dispatched", deadline: "2026-10-07T13:00:00Z", payoutCents: 1500 },
        { state: "dispatched", nudgeCount: 1, payoutCents: 500 },
      ],
      producing: [{ state: "accepted", deadline: "2026-10-20", payoutCents: 2000 }],
      shipped: [{ state: "shipped", deadline: "2026-10-01", nudgeCount: 3, payoutCents: 9000 }],
    },
    now,
  )
  assert.deepEqual(facts, {
    pending: 2,
    producing: 1,
    shipped: 1,
    urgent: 2,
    openCents: 4000,
  })
})

test("排单和钱包在前台轮询，后台失败不弹 toast", () => {
  assert.equal(SUPPLIER_PORTAL_POLL_MS, 15_000)
  const queue = readFileSync(new URL("./supplier-queue.tsx", import.meta.url), "utf8")
  const wallet = readFileSync(new URL("./supplier-wallet.tsx", import.meta.url), "utf8")
  assert.match(queue, /useVisiblePolling\(\{/)
  assert.match(queue, /quiet: trigger !== "mount"/)
  assert.match(wallet, /useVisiblePolling\(\{/)
  assert.match(wallet, /refresh\(trigger !== "mount"\)/)
})
