import type { ConsoleRefreshMetricsResponse } from "@/bindings/commands"
import { notifyInfo, notifySuccess } from "@/lib/notify"

export async function commitLatest<T>({
  request,
  isCurrent,
  commit,
  fail,
}: {
  request: () => Promise<T>
  isCurrent: () => boolean
  commit: (value: T) => void
  fail: (reason: unknown) => void
}): Promise<boolean> {
  try {
    const value = await request()
    if (!isCurrent()) return false
    commit(value)
    return true
  } catch (reason) {
    if (isCurrent()) fail(reason)
    return false
  }
}

export function shouldSoftReload(
  becameActive: boolean,
  hasPainted: boolean,
  actionBusy: boolean,
): boolean {
  return becameActive && hasPainted && !actionBusy
}

/** Announce a metrics refresh pass; per-store failures keep their last good data. */
export function announceRefresh(response: ConsoleRefreshMetricsResponse): void {
  const failed = response.results.filter((result) => result.status === "failed")
  const succeeded = response.results.length - failed.length
  if (response.results.length === 0) {
    notifySuccess("经营指标已是最新")
    return
  }
  if (failed.length === 0) {
    notifySuccess(`已刷新 ${succeeded} 家店铺`)
    return
  }
  notifyInfo(`已刷新 ${succeeded} 家，${failed.length} 家保留上次成功数据`, {
    description: failed.map((result) => result.error).filter(Boolean).join("；"),
  })
}
