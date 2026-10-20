/**
 * 行级 Ozon 配置会话 —— 「默认字段」分区对 `…/ozon-config` 的 CAS 写回。
 * 编码与 IO 边界在 `supplier-ozon-config.ts`；会话只管基线、身份与冲突。
 */
import type {
  CategorySchemaView,
  WorkflowCategoryDraft,
} from "@/bindings/commands"
import { commandErrorCode } from "@/lib/error-message"

import {
  draftToOzonConfigValues,
  type PutSupplierOzonConfigBody,
  type SupplierOzonConfigData,
  type SupplierOzonConfigIO,
} from "./supplier-ozon-config"

/**
 * 一行一次挂载 = 一个配置会话：PUT 目标（sourceId/productId）、回带字段
 * 与 CAS 基线都封在会话里。换行、换坐标、重挂载之后进行中的写仍只写它
 * 自己的行、用自己的基线 —— 不会拿新行的 revision 去签旧行的挂账。
 *
 * `conflicted` 是 409（`cloud_conflict`）后的死锁阀：冲突不再自动拉新基线
 * 再写（那会是静默最后写赢），由宿主界面引导用户重新读取后再改。
 */
export class OzonConfigSession {
  baseline: SupplierOzonConfigData | undefined
  /** 已卸下的会话不再碰宿主 UI —— 换行/换坐标/重试都会立新会话。 */
  disposed = false
  conflicted = false
  private rowRevision: number | undefined

  constructor(
    readonly sourceId: string,
    readonly productId: string,
    private readonly io: SupplierOzonConfigIO,
    baseline?: SupplierOzonConfigData,
  ) {
    this.baseline = baseline
  }

  async load(): Promise<SupplierOzonConfigData | undefined> {
    const next = await this.io.get(this.sourceId, this.productId)
    this.baseline = next
    this.conflicted = false
    return next
  }

  /**
   * 行 PUT / 提示词 PATCH 与本会话共用配置 revision（它们改提示词、标签时
   * 会推进它）。行版本变了、本地没有挂账且未冲突时重读基线，下一次写回
   * 签的就是新 revision；有挂账或已冲突则不动 —— 真并发仍按 409 停写。
   * 首次调用只记下行版本。返回 true 表示基线已重读。
   */
  async followRowRevision(rowRevision: number, clean: boolean): Promise<boolean> {
    const seen = this.rowRevision
    this.rowRevision = rowRevision
    if (seen === undefined || seen === rowRevision) return false
    if (!clean || this.conflicted) return false
    await this.load()
    return true
  }

  async save(
    draft: WorkflowCategoryDraft,
    schema: CategorySchemaView,
    coordinate: { descriptionCategoryId: number; typeId: number },
  ): Promise<SupplierOzonConfigData> {
    const base = this.baseline
    const body: PutSupplierOzonConfigBody = {
      description_category_id: coordinate.descriptionCategoryId,
      type_id: coordinate.typeId,
      language: base?.language ?? "zh_hans",
      prompt_text: base?.prompt_text ?? "",
      fixed_tags: base?.fixed_tags ?? [],
      ai_output: base?.ai_output ?? { title: true, description: true, tags: true },
      expected_revision: base?.revision ?? 0,
      values: draftToOzonConfigValues(draft, schema),
    }
    try {
      const saved = await this.io.put(this.sourceId, this.productId, body)
      this.baseline = saved
      this.conflicted = false
      return saved
    } catch (reason) {
      if (commandErrorCode(reason) === "cloud_conflict") this.conflicted = true
      throw reason
    }
  }
}
