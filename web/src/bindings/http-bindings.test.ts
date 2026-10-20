/**
 * HTTP wire clusters live in `http-*.ts`. commands.ts is types only.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { accountHttp } from "./http-account"
import { adminHttp } from "./http-admin"
import { integrationsHttp } from "./http-integrations"
import { opsHttp } from "./http-ops"
import { packsHttp } from "./http-packs"
import { listingHttp } from "./http-listing"
import { supplyChainHttp } from "./http-supply-chain"

const source = readFileSync(new URL("./commands.ts", import.meta.url), "utf8")

const forwarded = [
  "accountGetOverview",
  "accountLogin",
  "agentGetWorkbench",
  "adminListUsers",
  "integrationsListOzonStores",
  "opsShippingList",
  "productsSync",
  "messageCenterInbox",
  "consoleGetSnapshot",
  "fieldPackList",
  "listingCardLoadCard",
  "workflowRecognize",
  "workflowSend",
  "listingRowSaveDraft",
]

test("commands.ts is types-only and does not forward thunks", () => {
  for (const name of forwarded) {
    assert.doesNotMatch(source, new RegExp(`^\\s*${name}:`, "m"), name)
  }
  assert.doesNotMatch(source, /export const commands/)
  assert.doesNotMatch(source, /from "@\/features\/workflow/)
  assert.doesNotMatch(source, /export \{[\s\S]*accountHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*adminHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*integrationsHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*opsHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*packsHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*listingHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*supplyChainHttp/)
  assert.doesNotMatch(source, /export \{[\s\S]*workflowActions/)
})

test("a category tree read waits out another request's live fill (503 + Retry-After)", async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "类目数据正在读取，请稍后重试", code: "internal" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      })
    }
    return new Response(JSON.stringify({ data: { language: "zh_hans", fetched_at_ms: 1, tree: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  try {
    assert.deepEqual(await listingHttp.listingCardLoadCategoryTree({ language: "zh_hans" }), [])
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = previous
  }
})

test("each HTTP module exports its cluster object", () => {
  assert.equal(typeof accountHttp.accountGetOverview, "function")
  assert.equal(typeof accountHttp.agentSetPayoutAccount, "function")
  assert.equal(typeof accountHttp.agentRequestWithdrawal, "function")
  assert.equal(typeof accountHttp.agentTransferToWallet, "function")
  assert.equal(typeof adminHttp.adminListUsers, "function")
  assert.equal(typeof adminHttp.adminPayAgentWithdrawal, "function")
  assert.equal(typeof integrationsHttp.integrationsListOzonStores, "function")
  assert.equal(typeof opsHttp.opsShippingList, "function")
  assert.equal(typeof packsHttp.fieldPackList, "function")
  assert.equal(typeof listingHttp.listingCardLoadCard, "function")
  assert.equal(typeof supplyChainHttp.listPlatformCatalog, "function")
  assert.equal(typeof supplyChainHttp.getShippingReadiness, "function")
  assert.equal(typeof supplyChainHttp.ensureShipping, "function")
})
