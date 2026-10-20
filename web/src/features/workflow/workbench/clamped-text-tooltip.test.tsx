import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ClampedTextTooltip, isTextClamped } from "./clamped-text-tooltip"

test("a folded cell wires the hover tooltip onto the clamping element itself", () => {
  const html = renderToStaticMarkup(
    <ClampedTextTooltip text="完整的长文案">
      <span className="line-clamp-3">完整的长文案</span>
    </ClampedTextTooltip>,
  )
  // 触发属性合并进折叠元素本身，没有新增包装层；开灯与否由运行时的溢出
  // 检测决定，静态渲染不预设 —— 气泡内容不进初始标记。
  assert.match(html, /^<span[^>]*data-slot="tooltip-trigger"[^>]*>完整的长文案<\/span>$/)
  assert.doesNotMatch(html, /data-slot="tooltip-content"/)
})

test("an empty text renders the child untouched — a placeholder is not folded content", () => {
  const html = renderToStaticMarkup(
    <ClampedTextTooltip text="">
      <span className="line-clamp-3">等待 AI 识别…</span>
    </ClampedTextTooltip>,
  )
  assert.doesNotMatch(html, /data-slot="tooltip-trigger"/)
  assert.match(html, /^<span[^>]*>等待 AI 识别…<\/span>$/)
})

test("folding is judged by hidden overflow, with a subpixel tolerance", () => {
  assert.equal(isTextClamped({ scrollHeight: 60, clientHeight: 20 }), true)
  assert.equal(isTextClamped({ scrollHeight: 20, clientHeight: 20 }), false)
  assert.equal(isTextClamped({ scrollHeight: 20.5, clientHeight: 20 }), false)
})
