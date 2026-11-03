/** 同款事实只来自商品镜像；未读到的数据保持未知。 */
import type { StoreProductRow } from "./products-api"

export type StoreProductGroupFacts = {
  modelId?: number | null
  modelCount?: number | null
}

export function rowGroupFacts(row: StoreProductRow): StoreProductGroupFacts {
  return { modelId: row.model_id ?? null, modelCount: row.model_count ?? null }
}

export function groupCellView(facts: StoreProductGroupFacts): { text: string; hint: string } {
  if (facts.modelId == null) {
    return { text: "—", hint: "镜像没读到这件商品的同款分组；先同步店铺再看" }
  }
  if (facts.modelCount == null) {
    return { text: "已成组", hint: "Ozon 没报告同款件数，件数未知" }
  }
  return { text: `${facts.modelCount} 件同款`, hint: "Ozon 报告的同款成员件数" }
}
