import type { CSSProperties } from "react"

import { storeColorById, type StoreColorId } from "./store-colors"

export type StoreTone = ReturnType<typeof storeColorById>

export function storeToneFor(
  storeId: string,
  assignments: Readonly<Record<string, StoreColorId>>,
) {
  const colorId = assignments[storeId]
  return colorId ? storeColorById(colorId) : undefined
}

export function storeToneStyle(tone: StoreTone | undefined): CSSProperties | undefined {
  if (!tone) return undefined
  return {
    "--store-tone": tone.color,
    "--store-tone-ink": tone.ink,
  } as CSSProperties
}
