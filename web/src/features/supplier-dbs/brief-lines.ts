/**
 * 六行商品说明的前端镜像 —— 权威判定只有服务端
 * `src/platform/ocr_prompt.rs::validate_brief`（行数、行标、非空、标题公式、
 * 无汉字、≤4 KB），保存与就绪都由它裁决。本模块只做两件事，与
 * `@/lib/fixed-tags` 镜像 `ocr_tags.rs` 同一先例：
 *
 * 1. 结构化编辑器的机械拼装——六个行标与顺序由 UI 保证，内容仍交服务端校验；
 * 2. 入口软提示（哪行没写、含汉字、公式缺反引号）——不拒写、不另设判定，
 *    保存被拒时 toast 里是服务端的逐行中文原因。
 */
export const BRIEF_LINE_KEYS = [
  "goods",
  "theme",
  "title",
  "forbidden",
  "description",
  "invented",
] as const

export type BriefLineKey = (typeof BRIEF_LINE_KEYS)[number]

export type BriefLineDef = {
  key: BriefLineKey
  /** 行标（含冒号）——与服务端 BRIEF_LABELS 同序同拼写。 */
  label: string
  zh: string
  /** 这一行干什么（给不读俄文的构建者）。 */
  purpose: string
  /** 逐行写法要点，来自 prompts skill 的 lines.md 收敛。 */
  hint: string
}

export const BRIEF_LINES: readonly BriefLineDef[] = [
  {
    key: "goods",
    label: "Товар:",
    zh: "商品",
    purpose: "俄文商品名词打头，接已确认的规格/材质/结构/成套内容。",
    hint: "至少一条 «это НЕ …» 写最易误认成的商品；未确认的事实写 «не подтверждены»；型号照原样拼写（唯一允许拉丁字母的地方）。",
  },
  {
    key: "theme",
    label: "Тема:",
    zh: "主题",
    purpose: "主题取自画面哪部分，排除拍摄道具，看不清时的兜底主题。",
    hint: "常用 «Только принт»（只取印花）或 «Только видимое»（整幅即商品）；兜底 «Абстрактный принт»。",
  },
  {
    key: "title",
    label: "Заголовок:",
    zh: "标题",
    purpose: "反引号包住的标题公式：商品类型 → 规格 → 主题槽 → 固定尾。",
    hint: "主题槽写成直引号包住的 <тема>；尺寸用西里尔 х；公式里有尺寸时后面补 «Размер только с кириллической «х».»",
  },
  {
    key: "forbidden",
    label: "Не пиши:",
    zh: "禁词",
    purpose: "会改变商品事实的词，每个用 «…» 包住、逗号分隔。",
    hint: "近义但不同的商品、不成立的材质或功能、不包含的配件；与 «это НЕ …» 对得上。",
  },
  {
    key: "description",
    label: "Описание:",
    zh: "描述",
    purpose: "一行五句：类型与规格 → 固定事实 → Принт/Cюжет → 主色 → 使用场景。",
    hint: "槽写 <видимый принт>、<цвет1> 这类占位；固定句必须全是已确认事实，场景不许扩展成功能承诺。",
  },
  {
    key: "invented",
    label: "Не выдумывай:",
    zh: "禁造",
    purpose: "模型最容易编造的属性，逗号分隔、句号结尾。",
    hint: "Товар 里标为未确认的每一项都要在这里再列一次；常见项：вес、упаковку、стойкость принта。",
  },
]

/** 顺序敏感的值容器：拼装与解析都按 BRIEF_LINES 的声明顺序走。 */
export type BriefValues = Record<BriefLineKey, string>

export function emptyBriefValues(): BriefValues {
  return {
    goods: "",
    theme: "",
    title: "",
    forbidden: "",
    description: "",
    invented: "",
  }
}

/**
 * 把已落盘的说明解析回六个字段；不是规范的六行（旧整篇、空、多行）返回
 * null，调用方回落自由文本模式。容差与服务端一致：BOM、行首尾空白与
 * 空行都不影响，但六行顺序与行标必须严格匹配。
 */
export function parseBriefLines(content: string): BriefValues | null {
  const lines = content
    .replace(/^\u{feff}/u, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length !== BRIEF_LINES.length) return null
  const values = emptyBriefValues()
  for (const [index, line] of lines.entries()) {
    const def = BRIEF_LINES[index]
    if (!line.startsWith(def.label)) return null
    const value = line.slice(def.label.length).trim()
    if (!value) return null
    values[def.key] = value
  }
  return values
}

/**
 * 机械拼装：行标由 UI 保证，字段值只做去空白。全部字段为空时返回空串
 * （行 PUT 允许空正文当草稿保存），因此「清空」走自由文本模式之外没有
 * 隐藏入口。
 */
export function assembleBrief(values: BriefValues): string {
  const lines = BRIEF_LINES.map((def) => {
    const value = values[def.key].trim()
    return value ? `${def.label} ${value}` : ""
  })
  if (lines.every((line) => line === "")) return ""
  return lines.filter((line) => line !== "").join("\n")
}

/** 含汉字的软检查（服务端 contains_han 才是裁决）。 */
export function briefHasHan(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(value)
}

export type BriefAdvisory = {
  key: BriefLineKey
  /** 面向构建者的中文软提示；只描述入口问题，不裁决合法性。 */
  message: string
}

/**
 * 入口软提示：哪行没写、哪行含汉字、标题公式缺反引号或主题槽、超 4 KB。
 * 全部是「保存会被服务端拒绝的显性原因」——不含任何内容质量判断。
 */
export function briefAdvisories(values: BriefValues): BriefAdvisory[] {
  const advisories: BriefAdvisory[] = []
  const anyFilled = BRIEF_LINE_KEYS.some((key) => values[key].trim().length > 0)
  if (!anyFilled) return advisories
  for (const def of BRIEF_LINES) {
    const value = values[def.key].trim()
    const withLabel = `${def.label} ${value}`
    if (!value) {
      advisories.push({ key: def.key, message: `「${def.zh}」这一行还没写` })
      continue
    }
    if (briefHasHan(withLabel)) {
      advisories.push({ key: def.key, message: `「${def.zh}」含汉字，说明只能写俄文` })
    }
  }
  const title = values.title.trim()
  if (title) {
    const pieces = title.split("`")
    const formula = pieces.length > 2 && pieces.slice(1, -1).some((span) => span.includes('"<тема>"'))
    if (!formula) {
      advisories.push({
        key: "title",
        message: "标题公式要用一对反引号包住，且公式里有直引号包住的主题槽 <тема>",
      })
    }
  }
  const bytes = new TextEncoder().encode(assembleBrief(values)).length
  if (bytes > 4096) {
    advisories.push({
      key: "description",
      message: `说明超过 4 KB（现在 ${bytes} 字节）`,
    })
  }
  return advisories
}
