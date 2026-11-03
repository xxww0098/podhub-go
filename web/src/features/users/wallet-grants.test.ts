import assert from "node:assert/strict"
import test from "node:test"

import type { AdminDirectoryWorkspaceView, AdminUsersOverview } from "@/bindings/commands"
import {
  applyWalletToWorkspace,
  grantAttemptFor,
  grantCentsFromYuan,
} from "./wallet-grants"

test("grantCentsFromYuan converts yuan to fen inside the grantable range", () => {
  assert.equal(grantCentsFromYuan("1"), 100)
  assert.equal(grantCentsFromYuan(" 12.34 "), 1234)
  assert.equal(grantCentsFromYuan("10000"), 1_000_000)
})

test("grantCentsFromYuan rejects empty, non-numeric and out-of-range amounts", () => {
  assert.equal(grantCentsFromYuan(""), null)
  assert.equal(grantCentsFromYuan("abc"), null)
  assert.equal(grantCentsFromYuan("0"), null)
  assert.equal(grantCentsFromYuan("-5"), null)
  assert.equal(grantCentsFromYuan("0.99"), null)
  assert.equal(grantCentsFromYuan("10000.01"), null)
})

test("grantAttemptFor keeps the operation id on a retry of the same submission", () => {
  let minted = 0
  const mint = () => `op-${++minted}`
  const first = grantAttemptFor(undefined, "ws-1", 500, "补偿", mint)
  const retry = grantAttemptFor(first, "ws-1", 500, "  补偿 ", mint)
  assert.equal(first.operationId, "op-1")
  assert.equal(retry.operationId, "op-1")
  assert.equal(minted, 1)
})

test("grantAttemptFor mints a new id when workspace, amount or note change", () => {
  let minted = 0
  const mint = () => `op-${++minted}`
  const first = grantAttemptFor(undefined, "ws-1", 500, "补偿", mint)
  assert.equal(grantAttemptFor(first, "ws-2", 500, "补偿", mint).operationId, "op-2")
  assert.equal(grantAttemptFor(first, "ws-1", 600, "补偿", mint).operationId, "op-3")
  assert.equal(grantAttemptFor(first, "ws-1", 500, "", mint).operationId, "op-4")
})

test("grantAttemptFor mints a fresh id once the previous attempt was cleared", () => {
  let minted = 0
  const mint = () => `op-${++minted}`
  const first = grantAttemptFor(undefined, "ws-1", 500, "", mint)
  const again = grantAttemptFor(undefined, "ws-1", 500, "", mint)
  assert.notEqual(first.operationId, again.operationId)
})

function workspace(uuid: string, available: number, held: number): AdminDirectoryWorkspaceView {
  return {
    id: 1,
    uuid,
    name: uuid,
    owner_uuid: "owner",
    plan: "pro",
    seat_limit: 3,
    seats_used: 0,
    ai_tokens_used: 0,
    ai_tokens_monthly: 0,
    created_at: "2026-01-01",
    members: [],
    wallet_available_microfen: available,
    wallet_held_microfen: held,
  }
}

test("applyWalletToWorkspace replaces only the matching workspace's available and held", () => {
  const overview: AdminUsersOverview = {
    user_count: 0,
    workspace_count: 2,
    unaffiliated: [],
    workspaces: [workspace("ws-1", 10, 1), workspace("ws-2", 20, 2)],
  }
  const next = applyWalletToWorkspace(overview, "ws-2", { available_microfen: 99, held_microfen: 7 })
  assert.equal(next?.workspaces[0]?.wallet_available_microfen, 10)
  assert.equal(next?.workspaces[0]?.wallet_held_microfen, 1)
  assert.equal(next?.workspaces[1]?.wallet_available_microfen, 99)
  assert.equal(next?.workspaces[1]?.wallet_held_microfen, 7)
  assert.equal(overview.workspaces[1]?.wallet_available_microfen, 20)
})

test("applyWalletToWorkspace leaves the directory untouched for an unknown workspace", () => {
  const overview: AdminUsersOverview = {
    user_count: 0,
    workspace_count: 1,
    unaffiliated: [],
    workspaces: [workspace("ws-1", 10, 1)],
  }
  assert.equal(applyWalletToWorkspace(overview, "gone", { available_microfen: 1, held_microfen: 0 }), overview)
  assert.equal(applyWalletToWorkspace(undefined, "ws-1", { available_microfen: 1, held_microfen: 0 }), undefined)
})
