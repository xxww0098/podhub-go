import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["md", "compact", "meta"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs))
}

/**
 * The canonical UUID shape, case-insensitive; callers lowercase when they
 * canonicalize. Shared by correlation ids, invitations and report identities.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

/** 正整数 id：Cloud 自增主键的口径（`Number.isSafeInteger` 已排除非 number）。 */
export function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** 一个普通对象（非数组、非 null）——收窄 unknown 时的第一道守卫。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 运维关联 id（x-request-id / traceId）的白名单：可安全展示与落日志的
 * 字符集与长度。诊断、遥测与错误回报各处共用同一口径。
 */
export const TRACE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
