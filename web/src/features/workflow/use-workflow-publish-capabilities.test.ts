import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement, StrictMode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ScreenPane, useScreenActive } from "@/components/screen-pane"
import { useWorkflowPublishCapabilities } from "./use-workflow-publish-capabilities"
import { createWorkflowPublishNative } from "./workflow-publish-native"

test("publish capability SSR admits no owner or IO before effect setup", () => {
  const previous = globalThis.fetch
  let requests = 0, contexts = 0, nativeLoads = 0, observations = 0
  globalThis.fetch = (async () => { requests++; throw new Error("render cannot request business data") }) as typeof fetch
  const native = createWorkflowPublishNative(() => { nativeLoads++; throw new Error("render cannot execute native actions") })
  function Capture({ expectedActive = true }: { expectedActive?: boolean }) {
    assert.equal(useScreenActive(), expectedActive)
    const owner = useWorkflowPublishCapabilities(() => {
      contexts++
      return { active: true, blocked: false, generation: 1, controlVersion: 0 }
    }, native, undefined, () => { observations++ })
    assert.equal(owner, undefined)
    return null
  }
  try {
    assert.equal(renderToStaticMarkup(createElement(StrictMode, null, createElement(Capture))), "")
    for (const active of [false, true]) {
      renderToStaticMarkup(createElement(StrictMode, null, createElement(ScreenPane, {
        active, children: createElement(Capture, { expectedActive: active }),
      })))
    }
    assert.equal(requests, 0)
    assert.equal(contexts, 0)
    assert.equal(nativeLoads, 0)
    assert.equal(observations, 0)
  } finally { globalThis.fetch = previous }
})

// These wiring checks complement, never replace, the actual effect replay
// assertions in the browser's resident workbench / keepalive ScreenPane and
// their real native actions, including return with unchanged row/scope fences.
test("publish capability owner wiring confines creation and synchronous disposal to the effect", () => {
  const source = readFileSync(new URL("./use-workflow-publish-capabilities.ts", import.meta.url), "utf8")
  const effect = source.indexOf("useEffect(() => {")
  const cleanup = source.indexOf("return () => {", effect)
  const end = source.indexOf("}, [active])", cleanup)
  assert.ok(effect >= 0 && cleanup > effect && end > cleanup)
  const inactive = source.indexOf("if (!active) {", effect)
  const creation = source.indexOf("const current = createWorkflowPublishCapabilities(", effect)
  assert.ok(inactive > effect && creation > inactive && cleanup > creation)
  assert.match(source.slice(inactive, creation), /setOwner\(undefined\)\s+return/)
  assert.doesNotMatch(source.slice(inactive, creation), /context\(|native|observe|createWorkflowPublishCapabilities/)
  assert.equal((source.match(/const current = createWorkflowPublishCapabilities\(/g) ?? []).length, 1)
  assert.match(source.slice(effect, cleanup), /const value = latest\.current\.context\(\)/)
  assert.match(source.slice(effect, cleanup), /active: mounted && value\.active/)
  assert.match(source.slice(effect, cleanup), /\}, latest\.current\.native/)
  assert.match(source.slice(effect, cleanup), /latest\.current\.residentSession\?\.\(cardId\)/)
  assert.match(source.slice(effect, cleanup), /setOwner\(current\)/)
  const retiring = source.slice(cleanup, end)
  assert.ok(retiring.indexOf("current.dispose()") >= 0)
  assert.ok(retiring.indexOf("mounted = false") >= 0 && retiring.indexOf("mounted = false") < retiring.indexOf("current.dispose()"))
  assert.ok(retiring.indexOf("current.dispose()") < retiring.indexOf('observe?.("cleanup"'))
  assert.doesNotMatch(retiring, /await|setTimeout|queueMicrotask|Promise/)
  assert.match(source.slice(0, effect), /latest\.current = \{ context, native, residentSession, observe \}/)
  assert.match(source.slice(0, effect), /import \{ useScreenActive \} from "@\/components\/screen-pane"/)
  assert.match(source.slice(0, effect), /const active = useScreenActive\(\)/)
  assert.doesNotMatch(source.slice(0, effect), /context\(\)|createWorkflowPublishCapabilities\(/)
  assert.doesNotMatch(source.slice(0, effect), /useState\(\(\) => createWorkflowPublishCapabilities/)
  assert.match(source.slice(end), /return active \? owner : undefined/)
})

test("WorkflowScreen consumes the effect owner for both production remediation paths", () => {
  const source = readFileSync(new URL("./workflow-screen.tsx", import.meta.url), "utf8")
  assert.match(source, /const publishCapabilities = useWorkflowPublishCapabilities\(/)
  assert.match(source, /generation: runnerGeneration\.current, controlVersion: publishControlVersion\.current/)
  assert.match(source, /brandRepairCapability: publishCapabilities\?\.brandRepair/)
  assert.match(source, /publishCapabilities\?\.unknownRelease, publishCapabilities\?\.inspectUnknownRows/)
  assert.match(source, /canRepairRow=\{\(row, revision\) => publishCapabilities\?\.brandRepair\.current\(row, revision\) \?\? false\}/)
  assert.doesNotMatch(source, /createWorkflowPublishCapabilities\(|publishCapabilities\.dispose\(/)
})
