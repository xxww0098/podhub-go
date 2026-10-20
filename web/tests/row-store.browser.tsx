// Dev-only fixture for the local row store (specs/browser-owned-listing/slices/09-row-store.md).
// Not wired into production UI. Uses `listing-fixture-*` IndexedDB database
// names throughout — never the production `listing` name — so this page can
// never collide with real user data.
import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/toast"
import { loadAccountOverview } from "@/features/account/account-overview-cache"

import { openCardRows, type CardRows } from "@/features/workflow/rows/card-rows"
import { idbRowRepo, type RowRepo } from "@/features/workflow/rows/row-repo"
import { runRowRepoContract, sampleLocalRow } from "@/features/workflow/rows/row-repo.contract"
import { LocalStorageFullError, type LocalRow } from "@/features/workflow/rows/types"
import { errorMessage } from "@/lib/error-message"
import { reportError } from "@/lib/diag-log"
import { clearLive, notifyCommandError, notifyLive } from "@/lib/notify"
import "../src/index.css"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Wraps a RowRepo, counting IndexedDB transactions issued through it. */
function countingRepo(repo: RowRepo): { repo: RowRepo; counts: { puts: number; deletes: number } } {
  const counts = { puts: 0, deletes: 0 }
  const wrapped: RowRepo = {
    ...repo,
    async putRows(rows) {
      counts.puts += 1
      await repo.putRows(rows)
    },
    async deleteRows(ids) {
      counts.deletes += 1
      await repo.deleteRows(ids)
    },
  }
  return { repo: wrapped, counts }
}

function makeRowInput(
  scope: { workspaceUuid: string; cardId: string },
  position: number,
): Omit<LocalRow, "rev" | "createdAtMs" | "updatedAtMs"> {
  return {
    v: 1,
    id: crypto.randomUUID(),
    workspaceUuid: scope.workspaceUuid,
    cardId: scope.cardId,
    position,
    row: { title: `row ${position}`, fields: {} },
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Automated checks: the same contract every implementation must satisfy,
// plus the browser-only behaviors that need a real IndexedDB and real Web
// Locks (reload survival, tab handoff, stale-write rejection, perf bars). ---
async function runAutomatedChecks(log: (line: string) => void) {
  const runId = crypto.randomUUID().slice(0, 8)
  const contractDb = `listing-fixture-contract-${runId}`

  await runRowRepoContract(idbRowRepo(contractDb))
  log("PASS  RowRepo contract (idbRowRepo)")

  // Reload survival: a fresh idbRowRepo(...) call opens its own connection,
  // simulating a full page reload re-opening the database.
  const reloadDb = `listing-fixture-reload-${runId}`
  const beforeReload = idbRowRepo(reloadDb)
  const reloadRow = sampleLocalRow({ id: "reload-row", workspaceUuid: "ws-r", cardId: "card-r" })
  await beforeReload.putRows([reloadRow])
  const afterReload = idbRowRepo(reloadDb)
  const reread = await afterReload.rowsOfCard("ws-r", "card-r")
  check(reread.length === 1 && reread[0]?.id === "reload-row", "a row must survive a simulated reload")
  log("PASS  data survives a simulated reload")

  // Two tabs sharing one repo: the first openCardRows() grabs the write lock,
  // the second starts read-only and is promoted once the first closes.
  const lockDb = `listing-fixture-lock-${runId}`
  const lockRepo = idbRowRepo(lockDb)
  const lockScope = { workspaceUuid: "ws-lock", cardId: "card-lock" }
  const tabA = await openCardRows(lockRepo, lockScope)
  const tabB = await openCardRows(lockRepo, lockScope)
  check(tabA.writable, "the first tab must acquire the write lock")
  check(!tabB.writable, "the second tab must start read-only")
  const promoted = new Promise<void>((resolve) => {
    const unsubscribe = tabB.subscribe(() => {
      if (tabB.writable) {
        unsubscribe()
        resolve()
      }
    })
  })
  const handoffStart = performance.now()
  await tabA.close()
  await promoted
  const handoffMs = performance.now() - handoffStart
  check(tabB.writable, "the second tab must become writable after the writer closes")
  check(handoffMs < 1000, `handoff must complete within ~1s (took ${handoffMs.toFixed(0)}ms)`)
  log(`PASS  write-lock handoff after close() (${handoffMs.toFixed(0)}ms)`)
  await tabB.close()

  // Stale write: an expectRev mismatch is rejected, no write happens (I6).
  const revDb = `listing-fixture-rev-${runId}`
  const revRepo = idbRowRepo(revDb)
  const revScope = { workspaceUuid: "ws-rev", cardId: "card-rev" }
  const cardRows = await openCardRows(revRepo, revScope)
  cardRows.create([makeRowInput(revScope, 0)])
  const rowId = cardRows.all()[0]!.id
  await cardRows.flush()
  const currentRev = cardRows.get(rowId)!.rev
  const rejected = cardRows.update(rowId, (row) => ({ ...row, position: 999 }), { expectRev: currentRev + 1 })
  check(rejected === false, "a stale expectRev must be rejected")
  check(cardRows.get(rowId)!.position !== 999, "a rejected update must not write")
  await cardRows.close()
  log("PASS  expectRev mismatch discarded, no write")

  // Perf: reading 1000 rows must complete in <=300ms.
  const perfDb = `listing-fixture-perf-${runId}`
  const perfRepo = idbRowRepo(perfDb)
  const perfScope = { workspaceUuid: "ws-perf", cardId: "card-perf" }
  const now = Date.now()
  const thousandRows: LocalRow[] = Array.from({ length: 1000 }, (_, i) => ({
    ...makeRowInput(perfScope, i),
    rev: 1,
    createdAtMs: now,
    updatedAtMs: now,
  }))
  await perfRepo.putRows(thousandRows)
  const readStart = performance.now()
  const readBack = await perfRepo.rowsOfCard(perfScope.workspaceUuid, perfScope.cardId)
  const readMs = performance.now() - readStart
  check(readBack.length === 1000, "must read back all 1000 rows")
  check(readMs <= 300, `reading 1000 rows must take <=300ms (took ${readMs.toFixed(1)}ms)`)
  log(`PASS  read 1000 rows in ${readMs.toFixed(1)}ms (<=300ms)`)

  // Perf: 1000 update() calls spread across ~1s must produce <=10 IndexedDB transactions.
  const txDb = `listing-fixture-tx-${runId}`
  const { repo: countingTxRepo, counts } = countingRepo(idbRowRepo(txDb))
  const txScope = { workspaceUuid: "ws-tx", cardId: "card-tx" }
  const txCardRows = await openCardRows(countingTxRepo, txScope)
  txCardRows.create(Array.from({ length: 1000 }, (_, i) => makeRowInput(txScope, i)))
  await txCardRows.flush()
  counts.puts = 0
  const ids = txCardRows.all().map((row) => row.id)
  const batches = 20
  for (let batch = 0; batch < batches; batch += 1) {
    for (let i = 0; i < 50; i += 1) {
      const id = ids[batch * 50 + i]!
      txCardRows.update(id, (row) => ({ ...row, position: row.position + 1 }))
    }
    await sleep(50) // 20 * 50ms ~= 1s total, spread across several 250ms debounce windows
  }
  await txCardRows.flush()
  check(counts.puts <= 10, `1000 updates in ~1s must produce <=10 transactions (got ${counts.puts})`)
  log(`PASS  1000 updates over ~1s produced ${counts.puts} transactions (<=10)`)
  await txCardRows.close()
}

function AutomatedChecks() {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    setLines([])
    const log = (line: string) => setLines((prev) => [...prev, line])
    try {
      await runAutomatedChecks(log)
      log("ALL PASS")
    } catch (error) {
      log(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section>
      <h2>自动化契约测试</h2>
      <p>
        跑 <code>runRowRepoContract</code>（同一份契约函数跑 <code>idbRowRepo</code>），加刷新存活、
        两标签页写锁交接、<code>expectRev</code> 不符丢弃、读 1000 行耗时与 1000 次 update 事务数。
      </p>
      <button id="run" onClick={() => void run()} disabled={running}>
        {running ? "运行中…" : "运行测试"}
      </button>
      <pre id="results" style={{ background: "#f5f5f5", padding: 12, minHeight: 40, whiteSpace: "pre-wrap" }}>
        {lines.join("\n")}
      </pre>
    </section>
  )
}

function ManualDemo() {
  const [status, setStatus] = useState("打开中…")
  const [stats, setStats] = useState<{ puts: number; deletes: number; elapsedMs: number } | null>(null)
  const [writable, setWritable] = useState<boolean | null>(null)
  const [hasError, setHasError] = useState(false)
  const [rowCount, setRowCount] = useState(0)
  const cardRowsRef = useRef<CardRows | null>(null)
  const countsRef = useRef({ puts: 0, deletes: 0 })
  const failNextSaveRef = useRef(false)

  // The scope is read from the URL so two tabs opened at the exact same
  // address contend for the same write lock — open this page twice to see
  // the read-only banner and the handoff after closing the first tab.
  const scope = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return { workspaceUuid: params.get("ws") ?? "ws-manual", cardId: params.get("card") ?? "card-manual" }
  }, [])

  useEffect(() => {
    let disposed = false
    let unsubscribe = () => {}
    void (async () => {
      const baseRepo = idbRowRepo("listing-fixture-manual")
      const { repo, counts } = countingRepo({
        ...baseRepo,
        async putRows(rows) {
          if (failNextSaveRef.current) {
            failNextSaveRef.current = false
            throw new LocalStorageFullError(new DOMException("fixture quota", "QuotaExceededError"))
          }
          await baseRepo.putRows(rows)
        },
      })
      countsRef.current = counts
      const cardRows = await openCardRows(repo, scope)
      if (disposed) {
        await cardRows.close()
        return
      }
      cardRowsRef.current = cardRows
      setWritable(cardRows.writable)
      setRowCount(cardRows.all().length)
      setStatus("就绪")
      let lastError: unknown
      unsubscribe = cardRows.subscribe(() => {
        setWritable(cardRows.writable)
        setRowCount(cardRows.all().length)
        setHasError(cardRows.error !== undefined)
        if (cardRows.error !== undefined && cardRows.error !== lastError) {
          lastError = cardRows.error
          setStatus("等待处理")
          reportError("[row-store]", cardRows.error, { stage: "save" })
          notifyLive({
            id: "row-store-save",
            type: "error",
            title: errorMessage(cardRows.error, "本地行暂未保存，请重试"),
            action: {
              label: cardRows.writable ? "重试保存" : "重新打开",
              onClick: () => {
                if (!cardRows.writable) location.reload()
                else void cardRows.flush().catch(() => {}) // subscribe retains the failure notice
              },
            },
          })
        } else if (cardRows.error === undefined && lastError !== undefined) {
          lastError = undefined
          clearLive("row-store-save")
          setStatus("已保存")
        }
      })
    })().catch((error) => {
      if (disposed) return
      setStatus("打开失败")
      notifyCommandError(error, "打开本地行仓库失败")
    })
    return () => {
      disposed = true
      unsubscribe()
      clearLive("row-store-save")
      void cardRowsRef.current?.close().catch((error) => notifyCommandError(error, "保存并关闭本地行仓库失败"))
      cardRowsRef.current = null
    }
  }, [scope])

  async function writeThousand() {
    const cardRows = cardRowsRef.current
    if (!cardRows || !cardRows.writable) return
    setStatus("写入中…")
    countsRef.current.puts = 0
    countsRef.current.deletes = 0
    const start = performance.now()
    cardRows.create(Array.from({ length: 1000 }, (_, i) => makeRowInput(scope, i)))
    await cardRows.flush()
    setStats({ puts: countsRef.current.puts, deletes: countsRef.current.deletes, elapsedMs: performance.now() - start })
    setStatus("已写入 1000 行")
  }

  async function updateRandomSubset() {
    const cardRows = cardRowsRef.current
    if (!cardRows || !cardRows.writable) return
    setStatus("更新中…")
    countsRef.current.puts = 0
    countsRef.current.deletes = 0
    const start = performance.now()
    const ids = cardRows.all().map((row) => row.id)
    const subset = ids.filter(() => Math.random() < 0.3)
    for (const id of subset) cardRows.update(id, (row) => ({ ...row, position: row.position + 1 }))
    await cardRows.flush()
    setStats({ puts: countsRef.current.puts, deletes: countsRef.current.deletes, elapsedMs: performance.now() - start })
    setStatus(`已随机更新 ${subset.length} 行`)
  }

  async function simulateSaveFailure() {
    await loadAccountOverview()
    const cardRows = cardRowsRef.current
    if (!cardRows?.writable) return
    failNextSaveRef.current = true
    cardRows.create([makeRowInput(scope, cardRows.all().length)])
    await cardRows.flush()
  }

  function manualFailure(error: unknown) {
    if (cardRowsRef.current?.error !== error) notifyCommandError(error, "保存本地行失败，请重试")
  }

  return (
    <section>
      <h2>
        手动检查（{scope.workspaceUuid}/{scope.cardId}）
      </h2>
      <p>
        {writable === null
          ? "打开中…"
          : writable
            ? "可写 — 本标签页持有写锁"
            : hasError ? "写入已暂停，请处理通知中的问题"
              : "只读 — 另一个标签页持有写锁；写者关闭标签页后约 1 秒内自动接管"}
      </p>
      <button onClick={() => void writeThousand().catch(manualFailure)} disabled={!writable}>
        写入 1000 行
      </button>{" "}
      <button onClick={() => void updateRandomSubset().catch(manualFailure)} disabled={!writable}>
        随机更新一批
      </button>
      <button onClick={() => void simulateSaveFailure().catch(manualFailure)} disabled={!writable}>
        模拟一次存储空间不足
      </button>
      <p>
        状态：{status}；当前行数：{rowCount}
      </p>
      {stats && (
        <p>
          事务：put={stats.puts} delete={stats.deletes}；耗时 {stats.elapsedMs.toFixed(0)}ms
        </p>
      )}
      <p style={{ fontSize: 12, color: "#666" }}>
        用同一个地址（含 <code>?ws=&amp;card=</code> 参数时保持一致）再开一个标签页，可看到只读横幅与接管。
      </p>
    </section>
  )
}

function App() {
  return (
    <Toaster>
    <div>
      <h1>本地行仓库检查</h1>
      <AutomatedChecks />
      <hr />
      <ManualDemo />
    </div>
    </Toaster>
  )
}

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const root = createRoot(fixture)
root.render(<App />)
import.meta.hot?.dispose(() => root.unmount())
