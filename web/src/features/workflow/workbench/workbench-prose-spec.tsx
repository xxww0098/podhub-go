import { bannedTagRejection } from "@/lib/banned-tags"

/**
 * Cells sharing `WorkbenchProseEditor`; the model uses its single-line mode.
 */
export type WorkbenchEditableColumn = "name" | "description" | "tags" | "model"

export const PROSE_EDITOR: Record<
  WorkbenchEditableColumn,
  {
    title: string
    placeholder: string
    rows: number
    ariaLabel: (imageName: string) => string
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
}
