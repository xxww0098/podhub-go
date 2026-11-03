import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { DeviceStoragePanel } from "@/features/account/account-screen"
import { putSource, putTemplate } from "@/render/opfs"
import { setPinnedSources } from "@/render/opfs-cache"
import { buryChannel } from "@/render/opfs-io"
import { restoreOpfsTestGlobals, stubOpfs } from "@/render/opfs-test-support"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const dialogButton = (text: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
  .find((button) => button.textContent?.trim() === text)

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const fs = stubOpfs()
  // Keep both writes and clears in the in-memory filesystem, not an OPFS worker.
  buryChannel()
  Object.assign(navigator.storage, {
    estimate: async () => ({ usage: 64, quota: 1024 }),
    persisted: async () => true,
  })
  const root = createRoot(fixture)
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 2000
    while (!predicate()) {
      check(performance.now() < deadline, message)
      await frame()
    }
  }
  try {
    const template = await putTemplate(new Uint8Array([1, 2, 3]))
    const pinned = await putSource(new Uint8Array([4, 5]), "kept.jpg")
    const unpinned = await putSource(new Uint8Array([6, 7]), "removed.jpg")
    check(fs.written.has(`templates/${template}.psd`) && fs.written.has(`sources/${unpinned}/removed.jpg`), "fixture was not isolated in memory")
    setPinnedSources(async () => new Set([pinned]))
    flushSync(() => root.render(<DeviceStoragePanel />))
    await settle(() => !!fixture.querySelector('[aria-label="清理源图"]:not(:disabled)'), "source cleanup did not become available")

    fixture.querySelector<HTMLButtonElement>('[aria-label="清理PSD 模板"]')!.click()
    await settle(() => !!dialogButton("取消"), "template confirmation did not open")
    dialogButton("取消")!.click()
    await settle(() => !dialog(), "cancel did not close confirmation")
    check(fs.written.has(`templates/${template}.psd`), "cancel changed the isolated template")

    fixture.querySelector<HTMLButtonElement>('[aria-label="清理源图"]')!.click()
    await settle(() => !!dialogButton("清理"), "source confirmation did not open")
    check(dialog()?.textContent?.includes("在制品的源图不会被清理"), "source protection was not explained")
    dialogButton("清理")!.click()
    await settle(() => !fs.written.has(`sources/${unpinned}/removed.jpg`), "unreferenced source was not cleared")
    check(fs.written.has(`sources/${pinned}/kept.jpg`), "pinned source was deleted")
    check(fs.written.has(`templates/${template}.psd`), "source cleanup changed another family")
    await settle(() => !dialog(), "confirmation did not close after cleanup")
    await settle(() => fixture.textContent?.includes("已钉住 1 张") === true, "protected source usage did not reload")
    results.textContent = "PASS: cancel, per-family cleanup, protected source and refreshed usage"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    await restoreOpfsTestGlobals()
    run.disabled = false
  }
}
