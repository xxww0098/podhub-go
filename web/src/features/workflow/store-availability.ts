import type { OzonStoreView } from "@/bindings/commands"
import {
  activeCloudStoreUid,
  isStoreKeyExpired,
} from "@/features/stores/store-roster-cache"
import { parseStoreIds } from "./store-quota"

export type CardStoreAvailability = {
  ready: boolean
  label: string
  issue?: {
    title: string
    description: string
    action: "open-stores" | "edit-card"
    actionLabel: string
  }
}

function names(stores: readonly OzonStoreView[]): string {
  return stores.map((store) => store.label.trim() || store.id).join("、")
}

export function cardStoreAvailability(
  targetStoreId: string,
  stores: readonly OzonStoreView[],
): CardStoreAvailability {
  const ids = parseStoreIds(targetStoreId)
  const labels = ids.map(
    (id) => stores.find((store) => store.id === id)?.label?.trim() || id,
  )
  const label =
    labels.length > 1
      ? `${labels.length} 个店铺（${labels.join("、")}）`
      : labels[0] || "未绑定店铺"
  if (!ids.length) {
    return {
      ready: false,
      label,
      issue: {
        title: "上架方案未绑定店铺",
        description: "请编辑上架方案并选择当前 Workspace 的店铺",
        action: "edit-card",
        actionLabel: "返回上架方案",
      },
    }
  }

  const bound = ids.flatMap((id) => {
    const store = stores.find((candidate) => candidate.id === id)
    return store ? [store] : []
  })
  if (bound.length !== ids.length) {
    const missingCount = ids.length - bound.length
    return {
      ready: false,
      label: bound.length
        ? `${names(bound)} + ${missingCount} 个不在当前 Workspace`
        : "不在当前 Workspace",
      issue: {
        title: "绑定店铺不在当前 Workspace",
        description: "这个上架方案绑定的店铺已删除或属于其他 Workspace，请编辑上架方案重新选择",
        action: "edit-card",
        actionLabel: "返回上架方案",
      },
    }
  }

  const localOnly = bound.filter((store) => !store.cloud_store_uuid?.trim())
  if (localOnly.length) {
    return {
      ready: false,
      label,
      issue: {
        title: "店铺尚未加入 Workspace",
        description: `请先到「店铺」把 ${names(localOnly)} 导入当前 Workspace`,
        action: "open-stores",
        actionLabel: "打开店铺",
      },
    }
  }

  const unavailable = bound.filter(
    (store) => store.cloud_status !== "active" || !activeCloudStoreUid(store),
  )
  const missingCredential = unavailable.filter(
    (store) => store.cloud_status === "active" && !store.configured,
  )
  if (missingCredential.length) {
    return {
      ready: false,
      label,
      issue: {
        title: "Workspace 店铺密钥未配置",
        description: `请到「店铺」为 ${names(missingCredential)} 配置 Seller 密钥`,
        action: "open-stores",
        actionLabel: "打开店铺",
      },
    }
  }
  // A lapsed key is Cloud's `CREDENTIAL_EXPIRED` refusal, not a capacity
  // problem: name the key instead of the 停用/名额 copy below.
  const expired = bound.filter((store) => isStoreKeyExpired(store))
  if (expired.length) {
    return {
      ready: false,
      label,
      issue: {
        title: "店铺密钥已过期",
        description: `店铺密钥已过期；请在卖家后台重新生成密钥并在店铺设置登记后重新发送：${names(expired)}`,
        action: "open-stores",
        actionLabel: "打开店铺",
      },
    }
  }
  if (unavailable.length) {
    return {
      ready: false,
      label,
      issue: {
        title: "绑定店铺在当前 Workspace 不可用",
        description: `请到「店铺」查看 ${names(unavailable)} 的停用或名额状态`,
        action: "open-stores",
        actionLabel: "打开店铺",
      },
    }
  }

  return { ready: true, label }
}

/** Create-dialog gate: missing Seller credentials are an operable jump to 店铺. */
export function composeSellerCredentialIssue(
  storeId: string,
  stores: readonly OzonStoreView[],
): CardStoreAvailability["issue"] | undefined {
  if (storeId.trim()) {
    const availability = cardStoreAvailability(storeId, stores)
    return availability.issue?.action === "open-stores"
      ? availability.issue
      : undefined
  }
  if (!stores.length) {
    return {
      title: "还没有店铺",
      description: "请先到「店铺」添加店铺并配置 Seller 密钥，才能拉取 Ozon 类目。",
      action: "open-stores",
      actionLabel: "打开店铺",
    }
  }
  if (!stores.some((store) => activeCloudStoreUid(store))) {
    return {
      title: "Workspace 店铺密钥未配置",
      description: "请到「店铺」配置 Seller 密钥后即可搜索并选择 Ozon 类目。",
      action: "open-stores",
      actionLabel: "打开店铺",
    }
  }
  return undefined
}

/** Prefer the runner fallback Store, else the first Workspace Store that can talk to Seller. */
export function defaultListingCardStoreId(
  stores: readonly OzonStoreView[],
  fallbackStoreId = "",
): string {
  const fallback = fallbackStoreId.trim()
  if (fallback) {
    const hit = stores.find((store) => store.id === fallback)
    if (hit && activeCloudStoreUid(hit)) return hit.id
  }
  return stores.find((store) => activeCloudStoreUid(store))?.id ?? fallback
}
