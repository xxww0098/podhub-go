/**
 * 销售价 / 划线价的输入口径 —— 卡片列表的销售价列与上架表格的两列共用：
 * 空 = 清掉，正小数 = 写入（`,` 当小数点收），0 与胡写的都算无效（Ozon 直接拒）。
 */
export function parseSalePrice(raw: string): number | null | "invalid" {
  const text = raw.trim().replace(",", ".")
  if (!text) return null
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text)) return "invalid"
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return "invalid"
  return value
}
