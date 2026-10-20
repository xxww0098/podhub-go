/**
 * 类目选中后暖取平台 schema；缓存缺失由 Cloud 使用平台密钥补齐。
 * 同一坐标与语言的暖取和正式读取共享在途请求，不依赖工作区店铺。
 */
import type {
  CategorySchemaRequest,
  CategorySchemaView,
} from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"

const schemaFlights = new Map<string, Promise<CategorySchemaView>>()

/** 同一坐标 + 语言的 schema 拉取单飞；落定即出表，重试不受阻。 */
export function categorySchemaFlight(
  request: CategorySchemaRequest,
  loadSchema: (
    request: CategorySchemaRequest,
  ) => Promise<CategorySchemaView> = listingHttp.listingCardLoadCategorySchema,
): Promise<CategorySchemaView> {
  const key = [
    request.description_category_id,
    request.type_id,
    request.language ?? "default",
  ].join(":")
  const current = schemaFlights.get(key)
  if (current) return current
  const flight = loadSchema(request).finally(() => {
    if (schemaFlights.get(key) === flight) schemaFlights.delete(key)
  })
  schemaFlights.set(key, flight)
  return flight
}

/** 类目坐标落盘后暖取；失败由正式读取展示重试入口。 */
export function warmCategorySchemaOnce(
  coordinate: { descriptionCategoryId?: number | null; typeId?: number | null },
  options?: {
    loadSchema?: (
      request: CategorySchemaRequest,
    ) => Promise<CategorySchemaView>
  },
): Promise<void> {
  const descriptionCategoryId = coordinate.descriptionCategoryId
  const typeId = coordinate.typeId
  if (descriptionCategoryId == null || typeId == null) {
    return Promise.resolve()
  }
  return categorySchemaFlight(
    {
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      language: "zh_hans",
    },
    options?.loadSchema,
  ).then(() => {}, () => {})
}
