// Dev-only fixture for listing-core-wasm (specs/browser-owned-listing/slices/03-core-wasm.md).
// Not wired into production UI. Loads the golden/synthetic rows this slice's
// Bun test (`listing-core-wasm.test.ts`) already proved byte-exact against
// native, runs them through the same WASM module here, and shows the live
// verdict — a human-inspectable confirmation, not a second automated
// comparison (that's the Bun test's job).
//
// The page bans network for everything but its own static assets: every
// fixture and the wasm binary are fetched with the real `fetch` first (Vite
// `?url` imports resolve to same-origin static paths, exactly like
// `threaded-render.browser.ts`), then `window.fetch` is replaced with one
// that always rejects — so if any op ever tried to reach the network (it
// never should: I8 "导入、编辑、删除、校验、切片、Stop、空闲都是 0 次后端
// 调用"), this page would show it failing loudly instead of silently.
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"

import { createListingCore, type ListingCore } from "@/listing-core/wasm"
import type { CardPayload, CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import wasmUrl from "../../wasm/dist/browser/listing-state.wasm?url"
import "../src/index.css"

import decorativeSchemaUrl from "./fixtures/listing-core/decorative-wall-art-schema.json?url"
import cardUrl from "./fixtures/listing-core/golden-card-default.json?url"
import goldenRowUrl from "./fixtures/listing-core/golden-revalidate-row.json?url"
import syntheticRow0Url from "./fixtures/listing-core/synthetic-row-000.json?url"
import syntheticRow1Url from "./fixtures/listing-core/synthetic-row-001.json?url"
import syntheticRow2Url from "./fixtures/listing-core/synthetic-row-002.json?url"
import syntheticRow3Url from "./fixtures/listing-core/synthetic-row-003.json?url"
import syntheticRow4Url from "./fixtures/listing-core/synthetic-row-004.json?url"

type RowResult = {
  label: string
  offerId: string
  name: string
  fact: string
  contentReady: boolean
  issues: { field_key: string; code: string; message: string }[]
  evidenceDigest: string | null
}

type State =
  | { status: "loading" }
  | { status: "done"; results: RowResult[]; wasmBytes: number }
  | { status: "error"; message: string }

async function fetchJson<T>(realFetch: typeof fetch, url: string): Promise<T> {
  const response = await realFetch(url)
  if (!response.ok) throw new Error(`fixture fetch failed: ${url} (${response.status})`)
  return (await response.json()) as T
}

async function loadCore(realFetch: typeof fetch): Promise<{ core: ListingCore; wasmBytes: number }> {
  let memory: WebAssembly.Memory | undefined
  const imports = {
    env: {
      fill_random(ptr: number, len: number) {
        if (!memory) throw new Error("fill_random called before instantiation finished")
        crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len))
      },
    },
  }
  const bytes = await (await realFetch(wasmUrl)).arrayBuffer()
  const { instance } = await WebAssembly.instantiate(bytes, imports)
  memory = (instance.exports as unknown as { memory: WebAssembly.Memory }).memory
  return { core: createListingCore(instance.exports), wasmBytes: bytes.byteLength }
}

function fieldText(draft: LeanRow["draft"], key: string): string {
  const value = draft.values[key] as { value?: unknown } | undefined
  return typeof value?.value === "string" ? value.value : ""
}

async function run(): Promise<{ results: RowResult[]; wasmBytes: number }> {
  const realFetch = window.fetch.bind(window)

  const [schema, card, goldenRow, ...syntheticRows] = await Promise.all([
    fetchJson<CategorySchemaSnapshot>(realFetch, decorativeSchemaUrl),
    fetchJson<CardPayload>(realFetch, cardUrl),
    fetchJson<LeanRow>(realFetch, goldenRowUrl),
    fetchJson<LeanRow>(realFetch, syntheticRow0Url),
    fetchJson<LeanRow>(realFetch, syntheticRow1Url),
    fetchJson<LeanRow>(realFetch, syntheticRow2Url),
    fetchJson<LeanRow>(realFetch, syntheticRow3Url),
    fetchJson<LeanRow>(realFetch, syntheticRow4Url),
  ])
  const { core, wasmBytes } = await loadCore(realFetch)

  // From here on, nothing this page does may touch the network.
  window.fetch = () => Promise.reject(new Error("listing-core fixture: network disabled after load"))

  const handle = core.loadSchema({ snapshot: schema })
  const rows: [string, LeanRow][] = [
    ["golden: revalidate/complete-draft-passes", goldenRow],
    ...syntheticRows.map((row, index): [string, LeanRow] => [`synthetic: syn-${String(index).padStart(3, "0")}`, row]),
  ]
  const results = rows.map(([label, row]) => {
    const output = core.revalidate(handle, { card, nowMs: Date.now(), row })
    return {
      label,
      offerId: fieldText(output.row.draft, "offer_id"),
      name: fieldText(output.row.draft, "name"),
      fact: output.fact,
      contentReady: output.contentReady,
      issues: output.issues.map((issue) => ({ field_key: issue.field_key, code: issue.code, message: issue.message })),
      evidenceDigest: output.evidence?.digest ?? null,
    }
  })
  core.dropSchema(handle)
  return { results, wasmBytes }
}

function Page() {
  const [state, setState] = useState<State>({ status: "loading" })
  useEffect(() => {
    run()
      .then((outcome) => setState({ status: "done", ...outcome }))
      .catch((error: unknown) => setState({ status: "error", message: error instanceof Error ? error.message : String(error) }))
  }, [])

  if (state.status === "loading") return <p>Loading listing-core-wasm…</p>
  if (state.status === "error") return <p style={{ color: "red" }}>Failed: {state.message}</p>
  return (
    <div>
      <p>
        wasm artifact: {state.wasmBytes.toLocaleString()} bytes ({(state.wasmBytes / 1024 / 1024).toFixed(3)} MiB) · network
        disabled after load — every result below came from a pure WASM call.
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {["row", "offerId", "name", "fact", "contentReady", "issues", "evidenceDigest"].map((heading) => (
              <th key={heading} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" }}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.results.map((result) => (
            <tr key={result.label}>
              <td style={{ padding: "4px 8px" }}>{result.label}</td>
              <td style={{ padding: "4px 8px" }}>{result.offerId}</td>
              <td style={{ padding: "4px 8px" }}>{result.name}</td>
              <td style={{ padding: "4px 8px" }}>{result.fact}</td>
              <td style={{ padding: "4px 8px" }}>{String(result.contentReady)}</td>
              <td style={{ padding: "4px 8px" }}>
                {result.issues.length === 0 ? "—" : result.issues.map((issue) => `${issue.field_key}: ${issue.code}`).join("; ")}
              </td>
              <td style={{ padding: "4px 8px", fontFamily: "monospace", fontSize: "0.85em" }}>{result.evidenceDigest ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

createRoot(document.getElementById("fixture")!).render(<Page />)
