import { bannedTagRejection } from "@/lib/banned-tags"

/**
 * Cells sharing `WorkbenchProseEditor`; the model uses its single-line mode.
 */
export type WorkbenchEditableColumn = "name" | "description" | "tags" | "rich_content" | "model"

export const PROSE_EDITOR: Record<
  WorkbenchEditableColumn,
  {
    title: string
    placeholder: string
    rows: number
    ariaLabel: (imageName: string) => string
    /** Popup / textarea sizing overrides; unset keeps the compact prose default. */
    dialogClassName?: string
    textareaClassName?: string
    singleLine?: true
    /** Live draft check（编辑时逐键运行）：null = 可提交，string = 阻断提交的提示。 */
    validate?: (value: string) => string | null
  }
> = {
  name: {
    title: "商品名称",
    placeholder: "商品名称",
    rows: 3,
    ariaLabel: (imageName) => `商品名称 ${imageName}`,
  },
  description: {
    title: "商品简介",
    placeholder: "商品简介",
    rows: 5,
    ariaLabel: (imageName) => `商品简介 ${imageName}`,
  },
  tags: {
    title: "搜索标签",
    placeholder: "搜索标签，空格分隔",
    rows: 6,
    ariaLabel: (imageName) => `搜索标签 ${imageName}`,
    validate: bannedTagRejection,
  },
  model: {
    title: "型号",
    placeholder: "型号名称",
    rows: 1,
    ariaLabel: (imageName) => `型号 ${imageName}`,
    singleLine: true,
  },
  rich_content: {
    title: "JSON富内容",
    placeholder: "粘贴 JSON 富内容",
    rows: 12,
    ariaLabel: (imageName) => `JSON富内容 ${imageName}`,
    // 富内容是竖着贴的整份 JSON：弹窗放宽、文本框默认更高，长文档在框内滚动。
    dialogClassName:
      "max-h-[min(46rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-3xl",
    textareaClassName: "min-h-64 max-h-112",
    validate: validateRichContentJson,
  },
}

/**
 * JSON富内容必须是合法 JSON（Ozon 在发送时才拒绝，编辑时就拦下来）。
 * 空串合法 —— 空代表「不设默认 / 清空」，两个弹窗的保存路径都把空走清除。
 * 返回 null 表示可提交；返回中文提示时提交按钮与 ⌘/Ctrl+Enter 一并阻断。
 */
export function validateRichContentJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    JSON.parse(trimmed)
    return null
  } catch (reason) {
    return `JSON 格式错误：${jsonErrorHint(reason, trimmed)}`
  }
}

/**
 * 引擎的 SyntaxError 文案是英文实现细节，不直接进 DOM；只提取行列做定位，
 * 提取不到（引擎不给位置）就退回通用提示。新 V8 / Firefox 带 `line N column M`，
 * 旧 V8 只有 `position N`，按原文换算行列。
 */
function jsonErrorHint(reason: unknown, raw: string): string {
  const message = reason instanceof Error ? reason.message : ""
  const lineColumn = message.match(/line (\d+) column (\d+)/)
  if (lineColumn) return `第 ${lineColumn[1]} 行第 ${lineColumn[2]} 列附近有误`
  const position = message.match(/position (\d+)/)
  if (position) {
    const offset = Math.min(Number(position[1]), raw.length)
    const before = raw.slice(0, offset)
    const line = before.split("\n").length
    const column = offset - before.lastIndexOf("\n")
    return `第 ${line} 行第 ${column} 列附近有误`
  }
  return "请检查引号、逗号与括号是否配对"
}

/**
 * 弹窗里的实时校验状态行（说明性文案，非命令失败反馈）：合法走 muted，非法走
 * destructive，同时是 textarea `aria-describedby` 指向的说明节点。
 */
export function ProseDraftValidation({
  filled,
  error,
  id,
}: {
  /** 草稿非空才显示 —— 空草稿就是「清除」，没有格式可言。 */
  filled: boolean
  error: string | null
  id: string
}) {
  if (!filled) return null
  return (
    <p
      id={id}
      className={`text-meta ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {error ? `✗ ${error}` : "✓ JSON 格式正确"}
    </p>
  )
}
