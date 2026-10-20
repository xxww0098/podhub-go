/**
 * Geometry of the workbench action ribbon. The ribbon, its prepare / send /
 * live-status controls and the store quota picker all size against these, so
 * a track width changes in one place.
 */

/**
 * Persistent batch commands use the compact density of the shadcn small button.
 *
 * Every verb here carries a count, and a verb sitting at 0 is the one the
 * operator most needs explained. `<button disabled>` takes no pointer events, so
 * the tooltip holding that explanation could never open — these buttons pass
 * `focusableWhenDisabled` instead, which trades the native attribute for
 * `aria-disabled` and keeps hover and Tab reaching the control. Base UI still
 * swallows the click.
 */
export const RIBBON_BUTTON = "h-8 w-full min-w-0 px-2 text-xs"
export const RIBBON_SELECT_GROUP =
  "grid w-[84px] shrink-0 grid-cols-1 items-center px-0.5"
// 勾选后才出现的两个动词各占一条轨道：删除所选行，以及把型号批量写到这些行上。
export const RIBBON_SELECT_GROUP_PICKED =
  "w-[212px] grid-cols-[84px_60px_60px] gap-0.5"
/**
 * Every ribbon grid's column template must name one track per child: the
 * ribbon is one row by contract, and a fixed grid silently drops extra
 * children onto a clipped second row.
 * Track widths follow content: icon (14) + gap (6) + label + px-2 (16).
 */
export const RIBBON_MEDIA_GROUP =
  "grid w-[174px] shrink-0 grid-cols-[84px_84px] items-center gap-0.5 px-0.5"
export const RIBBON_MEDIA_GROUP_WITH_STORES =
  "w-[280px] grid-cols-[84px_84px_104px]"
/**
 * A supplier softlink Card reads 默认字段 from the online supplier config and
 * `updateCardDefault` is a no-op there, so the track is dropped with the button
 * instead of shipping a control that is disabled forever.
 */
export const RIBBON_MEDIA_GROUP_SUPPLIER =
  "grid w-[88px] shrink-0 grid-cols-[84px] items-center gap-0.5 px-0.5"
export const RIBBON_MEDIA_GROUP_SUPPLIER_WITH_STORES =
  "w-[194px] grid-cols-[84px_104px]"
/** 一键准备 + 识别/切片/上传 步骤轨 + 清空。清空带文字标签：它是准备的逆操作，混进步骤图标里没人找得到。 */
export const RIBBON_PREPARE_GROUP =
  "grid w-[256px] shrink-0 grid-cols-[64px_repeat(3,32px)_84px] items-center gap-0.5 px-0.5"

export const RIBBON_STATUS_GROUP = "grid w-[132px] shrink-0 grid-cols-1 items-center px-0.5"
export const RIBBON_PUBLISH_GROUP =
  "grid w-[192px] shrink-0 grid-cols-[104px_76px] items-center gap-0.5 px-0.5"
export const RIBBON_DIVIDER = "mx-1.5 h-5 w-px shrink-0 bg-border"
