import { WorkbenchCellPreview } from "./workbench/workbench-cell-editor"

export function CardThemeCell({
  title,
  value,
  disabled,
  unsupported = false,
  onOpen,
}: {
  title: string
  value: string
  disabled: boolean
  unsupported?: boolean
  onOpen: () => void
}) {
  return (
    <WorkbenchCellPreview
      value={unsupported ? "" : value}
      disabled={disabled}
      placeholder={unsupported ? "当前类目无主题属性" : "从 Ozon 字典选择主题"}
      ariaLabel={`主题 ${title}`}
      onOpen={onOpen}
    />
  )
}
