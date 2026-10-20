import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { sourceFiles } from "./publish-pipeline-browser-static"

const workbench = () => readFileSync(new URL("./publish-pipeline-workbench.tsx", import.meta.url), "utf8")

test("resident workbench uses the production hook inside StrictMode and requires actual replay evidence", () => {
  const source = workbench()
  const wrapper = source.indexOf("export function PublishPipelineWorkbench(")
  const resident = source.indexOf("function ResidentWorkbench(", wrapper)
  assert.ok(wrapper >= 0 && resident > wrapper)
  assert.match(source.slice(wrapper, resident), /<StrictMode><ResidentWorkbench \{\.\.\.props\} \/><\/StrictMode>/)
  assert.match(source.slice(resident), /const capabilities = useWorkflowPublishCapabilities\(\(\) => context\.current, native, peekCardSession/)
  assert.match(source, /if \(phase === "setup"\) lifecycle\.current\.setups\+\+/)
  assert.match(source, /lifecycle\.current\.cleanups\+\+; lifecycle\.current\.retired = owner/)
  assert.match(source, /lifecycle\.current\.setups >= 2 && lifecycle\.current\.cleanups >= 1/)
  assert.match(source, /lifecycle\.current\.retired !== capabilities/)
  assert.match(source, /retired\?\.brandRepair\.current\(row, view\.lifecycle\.revision\)/)
  assert.match(source, /capabilities\?\.brandRepair\.current\(row, view\.lifecycle\.revision\)/)
  assert.match(source, /return replayed && !retiredBrandAvailable && liveBrandAvailable === \(mode === "brand"\)/)
  assert.match(source, /recordNative\("workbench-capability-lifecycle"/)
  assert.match(source, /recordNative\("workbench-capability-current"/)
  const load = source.indexOf("void seedWorkbench(data).then(() => {")
  const admitted = source.indexOf("setLoaded(true)", load)
  assert.ok(load >= 0 && admitted > load)
  const admission = source.slice(load, admitted)
  assert.match(admission, /if \(!capture\(\)\)/)
  assert.match(admission, /return endAction\(measured, false\)/)
  assert.doesNotMatch(source, /createWorkflowPublishCapabilities\(/)
})

test("workbench Stop and scope controls retire the same owner without implicit replacement or business actions", () => {
  const source = workbench()
  for (const [startLabel, endLabel] of [["workbench-stop", "停止工作台动作"], ["workbench-scope", "离开工作台作用域"]] as const) {
    const start = source.indexOf(`beginAction("${startLabel}")`)
    const end = source.indexOf(endLabel, start)
    assert.ok(start >= 0 && end > start)
    const action = source.slice(start, end)
    assert.match(action, /capabilities\?\.dispose\(\)/)
    assert.match(action, /capture\(\); refresh/)
    assert.doesNotMatch(action, /seedWorkbench|useWorkflowPublishCapabilities|createWorkflowPublishNative|fetch\(|releaseUnknown|startPublish/)
  }
  assert.match(source, /context\.current\.controlVersion\+\+; context\.current\.blocked = true/)
  assert.match(source, /context\.current\.active = !context\.current\.active; context\.current\.generation\+\+/)
  assert.match(source, /capabilities && <WorkbenchActions capabilities=\{capabilities\}/)
})

test("workbench replay preserves real native observation and keeps schema seeding behind the explicit load", () => {
  const source = workbench()
  const effect = source.indexOf("const edit = core.editRow.bind(core)")
  const end = source.indexOf("}, [core, mocks])", effect)
  assert.ok(effect >= 0 && end > effect)
  const observing = source.slice(effect, end)
  assert.match(observing, /const result = await edit\(\.\.\.args\)/)
  assert.match(observing, /await mocks\.observeEdit\(result\)/)
  assert.match(observing, /const result = await revalidate\(\.\.\.args\)/)
  assert.match(observing, /fact: result\.fact/)
  assert.match(observing, /return \(\) => \{ mocks\.release\(\); core\.editRow = edit; core\.revalidate = revalidate \}/)
  assert.doesNotMatch(observing, /context\.current\.active =|capabilities.*dispose|seedWorkbench|fetch\(/)
  assert.equal((source.match(/seedWorkbench\(data\)/g) ?? []).length, 1)
  assert.ok(source.indexOf('beginAction("workbench-load")') < source.indexOf("seedWorkbench(data)"))
})

test("browser source closure includes the exact production capability hook without widening network policy", () => {
  const hook = "web/src/features/workflow/use-workflow-publish-capabilities.ts"
  assert.equal(sourceFiles.filter((file) => file === hook).length, 1)
  assert.ok(sourceFiles.includes("web/src/features/workflow/workflow-publish-capabilities.ts"))
  assert.ok(sourceFiles.includes("web/tests/publish-pipeline-workbench.tsx"))
  const policy = readFileSync(new URL("./publish-pipeline-browser-static.ts", import.meta.url), "utf8")
  assert.match(policy, /mocks: \[\], staticPrefixes: viteStaticPrefixes\(repoRoot, path\.join\(repoRoot, "web"\)\)/)
  assert.match(policy, /staticPaths: sourceFiles\.map\(/)
})

test("fixture entry wraps the actual React root in StrictMode and preserves Profiler evidence", () => {
  const source = readFileSync(new URL("./publish-pipeline.browser.tsx", import.meta.url), "utf8")
  const root = source.indexOf('createRoot(document.getElementById("fixture")!)')
  assert.ok(root >= 0)
  assert.match(source.slice(root), /\.render\(<StrictMode><Profiler id="publish-pipeline" onRender=\{recordCommit\}><Fixture \/><\/Profiler><\/StrictMode>\)/)
})

test("fixture setup retires its own async resources without publishing abandoned initialization", () => {
  const source = readFileSync(new URL("./publish-pipeline.browser.tsx", import.meta.url), "utf8")
  const effect = source.indexOf("useEffect(() => {")
  const end = source.indexOf("}, [])", effect)
  assert.ok(effect >= 0 && end > effect)
  const setup = source.slice(effect, end)
  assert.match(setup, /await loadSchema\(material\)\s+if \(!live\) return/)
  assert.match(setup, /ownedRows = rows\s+if \(!live\) return/)
  assert.match(setup, /await settlePaint\(\)\s+if \(live && harness\.current === owner\) markReady\(\)/)
  const cleanup = setup.indexOf("function closeResources()")
  const initialization = setup.indexOf("const initialized =", cleanup)
  assert.ok(cleanup >= 0 && initialization > cleanup)
  const closing = setup.slice(cleanup, initialization)
  assert.match(closing, /return closing \?\?=/)
  let previous = -1
  for (const boundary of ["await initialized.catch", "await owner?.queue.settled()", "await ownedRows?.close()", "await schemas.close()"] as const) {
    const at = closing.indexOf(boundary)
    assert.ok(at > previous, `${boundary} must exist after the previous cleanup boundary`)
    previous = at
  }
  const retire = setup.indexOf("function retire()")
  const caught = setup.indexOf("void initialized.catch", retire)
  assert.ok(retire > initialization && caught > retire)
  const retiring = setup.slice(retire, caught)
  assert.match(retiring, /live = false; unsubscribe\(\); owner\?\.queue\.stop\(\)/)
  assert.match(retiring, /if \(harness\.current === owner\) harness\.current = null/)
  assert.doesNotMatch(retiring, /await|harness\.current\?\.(?:queue|rows)|harness\.current\.(?:queue|rows)|setLoaded|markReady/)
  assert.match(setup, /return retire/)
})
