import assert from "node:assert/strict"
import test from "node:test"
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "@/components/ui/button"
import { DialogContent } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { CardRichContentDialog, CardThemeCell } from "./card-default-cells"
import {
  ProseDraftValidation,
  validateRichContentJson,
} from "./workbench/workbench-cell-editor"

/**
 * SSR 不挂 Base UI 的 portal（同 field-workbench.test 的 defaultFieldsTree）：
 * 直接调用组件函数截获 portal 边界之前的元素树，再逐个子元素断言。
 */
function dialogElements(value: string) {
  let root!: ReactElement
  function Capture() {
    root = CardRichContentDialog({
      open: true,
      title: "15盎司白色马克杯",
      value,
      onClose: () => undefined,
      onSave: () => undefined,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [root]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const element = pending.pop()
    if (!isValidElement<Record<string, unknown>>(element)) continue
    elements.push(element)
    pending.push(...Children.toArray(element.props.children as ReactNode))
  }
  return elements
}

function elementByType(
  elements: ReactElement<Record<string, unknown>>[],
  type: unknown,
) {
  return elements.find((element) => element.type === type)
}

function buttonByLabel(
  elements: ReactElement<Record<string, unknown>>[],
  label: string,
) {
  const button = elements.find(
    (element) => element.type === Button && element.props.children === label,
  )
  assert.ok(button, `missing ${label} button`)
  return button
}

test("无主题属性的卡片显示禁用提示，不保留旧主题也不能打开选择器", () => {
  const html = renderToStaticMarkup(
    <CardThemeCell
      title="15盎司白色马克杯"
      value="旧主题"
      disabled
      unsupported
      onOpen={() => { throw new Error("must not open") }}
    />,
  )
  assert.match(html, /<p[^>]*aria-label="主题 15盎司白色马克杯"/)
  assert.match(html, /当前类目无主题属性/)
  assert.doesNotMatch(html, /旧主题|<button/)
})

test("validateRichContentJson：空=清除默认合法，合法 JSON 通过，非法给出中文提示", () => {
  assert.equal(validateRichContentJson(""), null)
  assert.equal(validateRichContentJson("  \n "), null)
  assert.equal(validateRichContentJson('{"content":[{"type":"text"}]}'), null)
  const error = validateRichContentJson('{\n  "a": 1,\n}')
  assert.match(error ?? "", /^JSON 格式错误/)
})

test("名册 JSON富内容 弹窗放宽：宽弹窗 + 高文本框", () => {
  const elements = dialogElements('{"content":[]}')
  const content = elementByType(elements, DialogContent)
  assert.ok(content, "missing DialogContent")
  assert.match(String(content.props.className), /sm:max-w-3xl/)
  assert.match(String(content.props.className), /overflow-y-auto/)
  const textarea = elementByType(elements, Textarea)
  assert.ok(textarea, "missing Textarea")
  assert.equal(textarea.props.rows, 12)
  assert.match(String(textarea.props.className), /min-h-64/)
  assert.match(String(textarea.props.className), /max-h-112/)
})

test("名册 JSON富内容 弹窗：合法草稿显示通过态，保存可用", () => {
  const elements = dialogElements('{"content":[]}')
  const textarea = elementByType(elements, Textarea)
  assert.ok(textarea)
  assert.equal(textarea.props["aria-invalid"], undefined)
  const status = renderToStaticMarkup(
    elementByType(elements, ProseDraftValidation) ?? <p />,
  )
  assert.match(status, /✓ JSON 格式正确/)
  assert.notEqual(buttonByLabel(elements, "保存").props.disabled, true)
})

test("名册 JSON富内容 弹窗：非法草稿标记 aria-invalid 并阻断保存", () => {
  const elements = dialogElements('{"broken')
  const textarea = elementByType(elements, Textarea)
  assert.ok(textarea)
  assert.equal(textarea.props["aria-invalid"], true)
  assert.match(
    renderToStaticMarkup(elementByType(elements, ProseDraftValidation) ?? <p />),
    /✗ JSON 格式错误/,
  )
  assert.match(
    renderToStaticMarkup(buttonByLabel(elements, "保存")),
    /disabled=""/,
  )
})

test("名册 JSON富内容 弹窗：空草稿无校验状态行，保存可用（空=清除默认）", () => {
  const elements = dialogElements("")
  assert.equal(
    renderToStaticMarkup(elementByType(elements, ProseDraftValidation) ?? <p />),
    "",
  )
  assert.notEqual(buttonByLabel(elements, "保存").props.disabled, true)
})
