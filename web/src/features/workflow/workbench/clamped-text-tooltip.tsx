import { useState, type PointerEvent, type ReactElement } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** 折叠元素的 scrollHeight/clientHeight 可能各带小数，留 1px 余量防误判。 */
const SUBPIXEL_TOLERANCE = 1

/**
 * line-clamp 折叠文字是否真的把内容折掉了（隐藏溢出才算，文字长短不算 ——
 * 短文本折不掉任何东西，弹一个与可见内容相同的气泡只是噪音）。
 */
export function isTextClamped(element: {
  scrollHeight: number
  clientHeight: number
}): boolean {
  return element.scrollHeight > element.clientHeight + SUBPIXEL_TOLERANCE
}

/**
 * line-clamp 折叠格的悬停全文：内容被折掉时悬停弹出完整内容的 Tooltip，
 * 没折不弹。是否开灯完全受控 —— Base UI 自己的悬停开灯请求（onOpenChange
 * 传入 true）被忽略，开灯只由指针进入时的溢出检测决定；关灯（指针离开、
 * 点击）仍交给 Base UI 的既有语义。
 *
 * children 必须是承担 line-clamp 的元素本身：TooltipTrigger 经 render 把
 * 触发属性合并进去，不新增包装层，格子的布局与语义不变。
 */
export function ClampedTextTooltip({
  text,
  className,
  children,
}: {
  /** 折叠前的完整内容；空串不弹 —— 占位提示不是被折掉的内容。 */
  text: string
  /** 追加到气泡内容上的类；默认已封顶宽度/高度并保留换行，覆盖长文案。 */
  className?: string
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  if (!text) return children
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false)
      }}
    >
      <TooltipTrigger
        render={children}
        onPointerEnter={(event: PointerEvent<HTMLElement>) => {
          setOpen(isTextClamped(event.currentTarget))
        }}
      />
      <TooltipContent
        className={cn(
          "max-h-[min(24rem,50dvh)] max-w-md overflow-y-auto whitespace-pre-wrap break-words text-left",
          className,
        )}
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
