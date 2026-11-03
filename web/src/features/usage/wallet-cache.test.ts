import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

import type { WalletView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  invalidateWallet,
  loadWallet,
  peekWallet,
  peekWalletLedger,
  subscribeWallet,
} from "./wallet-cache"

type Detail = Awaited<ReturnType<typeof accountHttp.accountGetWalletDetail>>

function detail(availableYuan: number, note = ""): Detail {
  return {
    wallet: wallet(availableYuan),
    ledger: note
      ? [{ entry_type: "topup", amount_microfen: availableYuan * 100_000_000, balance_after_microfen: availableYuan * 100_000_000, note, created_at: "2026-08-24T00:00:00Z" }]
      : [],
    recharges: [],
  }
}

function wallet(availableYuan: number): WalletView {
  const available_microfen = availableYuan * 100_000_000
  return {
    available_microfen,
    held_microfen: 0,
    balance_microfen: available_microfen,
    spent_microfen: 0,
    updated_at: "2026-08-24T00:00:00Z",
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function readNearby(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

test("a later wallet load updates every subscriber", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWalletDetail
  const empty = deferred<Detail>()
  const topped = deferred<Detail>()
  const responses = [empty.promise, topped.promise]
  accountHttp.accountGetWalletDetail = () => responses.shift()!
  t.after(() => {
    accountHttp.accountGetWalletDetail = original
    invalidateWallet()
  })

  const seen: Array<number | null> = []
  const stop = subscribeWallet(() => {
    seen.push(peekWallet()?.available_microfen ?? null)
  })
  t.after(stop)

  const first = loadWallet()
  empty.resolve(detail(0))
  await first
  assert.equal(peekWallet()?.available_microfen, 0)

  const second = loadWallet()
  topped.resolve(detail(10))
  await second
  assert.equal(peekWallet()?.available_microfen, 1_000_000_000)
  assert.deepEqual(seen, [0, 1_000_000_000])
})

test("a request resolved after invalidate cannot repopulate the cache", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWalletDetail
  const pending = deferred<Detail>()
  accountHttp.accountGetWalletDetail = () => pending.promise
  t.after(() => {
    accountHttp.accountGetWalletDetail = original
    invalidateWallet()
  })

  const request = loadWallet()
  invalidateWallet()
  pending.resolve(detail(10))
  await request
  assert.equal(peekWallet(), null)
})

test("concurrent loads share one in-flight request", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWalletDetail
  let calls = 0
  const pending = deferred<Detail>()
  accountHttp.accountGetWalletDetail = () => {
    calls += 1
    return pending.promise
  }
  t.after(() => {
    accountHttp.accountGetWalletDetail = original
    invalidateWallet()
  })

  const first = loadWallet()
  const second = loadWallet()
  pending.resolve(detail(10))
  assert.equal(await first, await second)
  assert.equal(calls, 1)
  assert.equal(peekWallet()?.available_microfen, 1_000_000_000)
})

test("the ledger rides the same read and is fenced by invalidateWallet", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWalletDetail
  accountHttp.accountGetWalletDetail = async () => detail(5, "手动充值")
  t.after(() => {
    accountHttp.accountGetWalletDetail = original
    invalidateWallet()
  })

  assert.equal(peekWalletLedger(), null)
  const seen: number[] = []
  const stop = subscribeWallet(() => seen.push(peekWalletLedger()?.length ?? -1))
  t.after(stop)

  await loadWallet()
  assert.equal(peekWalletLedger()?.[0]?.note, "手动充值")
  // A Workspace switch drops the previous Workspace's balance and ledger together
  // and tells subscribers, so no surface keeps printing them.
  invalidateWallet()
  assert.equal(peekWallet(), null)
  assert.equal(peekWalletLedger(), null)
  assert.deepEqual(seen, [1, -1])
})

test("header, 用量 and redeem share the wallet cache", () => {
  const cache = readNearby("./wallet-cache.ts")
  const queryClientModule = readNearby("../../lib/query-client.ts")
  const header = readNearby("../../components/workspace-quota-facts.tsx")
  const usage = readNearby("./usage-stats-panel.tsx")
  const redeem = readNearby("../plans/redeem-code-dialog.tsx")
  const shell = readNearby("../../app/authenticated-app.tsx")
  const app = readNearby("../../app/App.tsx")
  const workspace = readNearby("../workspace/workspace-screen.tsx")

  assert.match(queryClientModule, /from "@tanstack\/react-query"/)
  assert.match(cache, /@tanstack\/react-query/)
  assert.match(header, /useWallet/)
  assert.match(header, /loadWallet/)
  assert.doesNotMatch(header, /accountGetWallet/)
  assert.match(usage, /useWallet/)
  assert.match(usage, /loadWallet/)
  assert.doesNotMatch(usage, /accountGetWallet/)
  assert.match(redeem, /void loadWallet\(\)/)
  assert.match(shell, /invalidateWallet/)
  assert.match(usage, /useWalletLedger/)
  // Sign-out sweeps every registered session cache in one call (lib/session-cache).
  assert.match(app, /invalidateAllSessionCaches/)
  assert.match(workspace, /invalidateWallet/)
})
