import assert from "node:assert/strict"
import test from "node:test"
import { errorMessage } from "@/lib/error-message"
import { awaitChosenFiles, psdTemplateRefusal, PSD_TEMPLATE_MAX_BYTES } from "./file-picker"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class PickerInput extends EventTarget {
  files: File[] | null = []
  removed = false
  remove() { this.removed = true }
}

/** Chromium and current Firefox expose `oncancel` on the file input. */
class CancelInput extends PickerInput {
  oncancel: ((event: Event) => void) | null = null
}

const apron = () => new File(["psd"], "【JIT】无口袋成人围裙.psd")

function asInput(input: PickerInput): HTMLInputElement {
  return input as unknown as HTMLInputElement
}

test("焦点回到窗口之后才到达的 change 仍是一次选中", async () => {
  const input = new CancelInput()
  const win = new EventTarget()
  const pending = awaitChosenFiles(asInput(input), win)
  await delay(0)
  win.dispatchEvent(new Event("focus"))
  await delay(450)
  input.files = [apron()]
  input.dispatchEvent(new Event("change"))
  const files = await pending
  assert.equal(files.length, 1)
  assert.equal(files[0]?.name, "【JIT】无口袋成人围裙.psd")
  assert.equal(input.removed, true)
})

test("取消选择保持空结果", async () => {
  const input = new CancelInput()
  const pending = awaitChosenFiles(asInput(input), new EventTarget())
  await delay(0)
  input.dispatchEvent(new Event("cancel"))
  assert.deepEqual(await pending, [])
})

test("取消事件带着已选文件时保留文件", async () => {
  const input = new CancelInput()
  const file = apron()
  input.files = [file]
  const pending = awaitChosenFiles(asInput(input), new EventTarget())
  await delay(0)
  input.dispatchEvent(new Event("cancel"))
  assert.equal((await pending)[0], file)
})

test("新的选择框可以再次选中同一个文件名", async () => {
  const file = apron()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const input = new CancelInput()
    const pending = awaitChosenFiles(asInput(input), new EventTarget())
    await delay(0)
    input.files = [file]
    input.dispatchEvent(new Event("change"))
    assert.equal((await pending)[0]?.name, file.name)
  }
})

test("没有 cancel 事件的引擎仍把焦点超时当成取消", async () => {
  const input = new PickerInput()
  const win = new EventTarget()
  const pending = awaitChosenFiles(asInput(input), win)
  await delay(0)
  win.dispatchEvent(new Event("focus"))
  assert.deepEqual(await pending, [])
})

test("超过 128 MiB 的 PSD 可以绑定，Windows 空 MIME 不拒绝", () => {
  const size = 140 * 1024 * 1024
  assert.ok(size > 128 * 1024 * 1024)
  assert.ok(size < PSD_TEMPLATE_MAX_BYTES)
  assert.equal(psdTemplateRefusal({ name: "【JIT】无口袋成人围裙.psd", size, type: "" }), null)
  assert.equal(psdTemplateRefusal({
    name: "apron.psb",
    size,
    type: "image/vnd.adobe.photoshop",
  }), null)
})

test("超过 500 MB 或不是 PSD 的文件给出中文原因", () => {
  const huge = psdTemplateRefusal({
    name: "apron.psd",
    size: PSD_TEMPLATE_MAX_BYTES + 1,
    type: "",
  })
  assert.equal((huge as { code?: string } | null)?.code, "workflow_template_too_large")
  assert.equal(
    errorMessage(huge, "无法保存 PSD 绑定，请稍后重试。"),
    "这份 PSD 超过 500 MB，无法绑定 请压缩或另存为较小的文件后再试。",
  )
  const kind = psdTemplateRefusal({ name: "apron.jpg", size: 100, type: "image/jpeg" })
  assert.equal((kind as { code?: string } | null)?.code, "workflow_template_type")
  assert.match(kind?.message ?? "", /psd/)
  const empty = psdTemplateRefusal({ name: "apron.psd", size: 0, type: "" })
  assert.equal((empty as { code?: string } | null)?.code, "workflow_template_empty")
  assert.match(empty?.message ?? "", /[\u3400-\u9fff]/)
})
