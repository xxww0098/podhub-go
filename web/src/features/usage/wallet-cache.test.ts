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
  subscribeWallet,
} from "./wallet-cache"

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
  const original = accountHttp.accountGetWallet
  const empty = deferred<WalletView>()
  const topped = deferred<WalletView>()
  const responses = [empty.promise, topped.promise]
  accountHttp.accountGetWallet = () => responses.shift()!
  t.after(() => {
    accountHttp.accountGetWallet = original
    invalidateWallet()
  })

  const seen: Array<number | null> = []
  const stop = subscribeWallet(() => {
    seen.push(peekWallet()?.available_microfen ?? null)
  })
  t.after(stop)

  const first = loadWallet()
  empty.resolve(wallet(0))
  await first
  assert.equal(peekWallet()?.available_microfen, 0)

  const second = loadWallet()
  topped.resolve(wallet(10))
  await second
  assert.equal(peekWallet()?.available_microfen, 1_000_000_000)
  assert.deepEqual(seen, [0, 1_000_000_000])
})

test("a request resolved after invalidate cannot repopulate the cache", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWallet
  const pending = deferred<WalletView>()
  accountHttp.accountGetWallet = () => pending.promise
  t.after(() => {
    accountHttp.accountGetWallet = original
    invalidateWallet()
  })

  const request = loadWallet()
  invalidateWallet()
  pending.resolve(wallet(10))
  await request
  assert.equal(peekWallet(), null)
})

test("concurrent loads share one in-flight request", async (t) => {
  invalidateWallet()
  const original = accountHttp.accountGetWallet
  let calls = 0
  const pending = deferred<WalletView>()
  accountHttp.accountGetWallet = () => {
    calls += 1
    return pending.promise
  }
  t.after(() => {
    accountHttp.accountGetWallet = original
    invalidateWallet()
  })

  const first = loadWallet()
  const second = loadWallet()
  pending.resolve(wallet(10))
  assert.equal(await first, await second)
  assert.equal(calls, 1)
  assert.equal(peekWallet()?.available_microfen, 1_000_000_000)
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
  // Sign-out sweeps every registered session cache in one call (lib/session-cache).
  assert.match(app, /invalidateAllSessionCaches/)
  assert.match(workspace, /invalidateWallet/)
})
