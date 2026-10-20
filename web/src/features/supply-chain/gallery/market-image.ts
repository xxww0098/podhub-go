import { route } from "@/api/routes"

/**
 * 货盘图集和视频封面走本站缩略图，而不是每次打开都重下对象存储原图。
 *
 * 原图最大 20MB。缩略图地址带 `Cache-Control: private, max-age=31536000, immutable`，
 * 浏览器按这个地址自己缓存。认不出的地址（测试夹具、非本桶）原样返回。
 */
const MARKET_IMAGE = /\/supplier-dbs\/([^/]+)\/([0-9a-fA-F]{64})\.(jpg|png|webp)$/i

export const MARKET_IMAGE_EDGES = [256, 640, 1280] as const
export type MarketImageEdge = (typeof MARKET_IMAGE_EDGES)[number]

export function marketImageSrc(url: string, edge: MarketImageEdge): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return url
  }
  const match = pathname.match(MARKET_IMAGE)
  if (!match) return url
  const sourceId = decodeURIComponent(match[1])
  const file = `${match[2].toLowerCase()}.${match[3].toLowerCase()}`
  return `${route("supplierDbsCatalogImagesBySourceIdByFile", {
    source_id: sourceId,
    file,
  })}?edge=${edge}`
}
