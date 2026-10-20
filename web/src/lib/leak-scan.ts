/**
 * DTO 防火墙扫描器的共享机械（seller/supplier/delegate 各防火墙共用）：
 * 键名归一化（去 `_`/`-`、小写）、按名单 + 前缀匹配、深度收键。
 * 名单与公开 API 留在各域文件里——这里只放不随域变的扫描逻辑。
 */

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase()
}

function collectKeys(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.push(key)
      collectKeys(child, into)
    }
  }
}

/** Keys in `value` hitting the forbidden list or any prefix; `null` 值也算。 */
export function collectLeakedKeys(
  value: unknown,
  forbiddenKeys: readonly string[],
  forbiddenPrefixes: readonly string[],
): string[] {
  const keys: string[] = []
  collectKeys(value, keys)
  return keys.filter((key) => {
    const normalized = normalizeKey(key)
    return (
      Boolean(normalized) &&
      (forbiddenKeys.includes(normalized) ||
        forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix)))
    )
  })
}
