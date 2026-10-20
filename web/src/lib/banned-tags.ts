/**
 * Live check for the platform banned-tag list.
 *
 * The server is the authority: saves and the Ozon body use `listing_core`.
 * This copy exists so a keystroke can refuse a tag before that round trip.
 * It is not the listing-core wasm module because the supplier prompt editor
 * and the platform prompt screen do not load that module.
 *
 * Keep the steps aligned with `rust/crates/listing-core/src/banned_tags.rs` and
 * `fold_latin_lookalikes` in `ocr_script.rs`. Spaces and hyphens fold to `_`.
 */

import { api } from "@/api/client"
import { route } from "@/api/routes"

export type BannedTagRule = {
  term: string
  matchMode: string
}

const INFLECTION_SUFFIXES = [
  "ами", "ями", "ого", "ему", "ыми", "ими", "ах", "ях", "ов", "ев", "ой", "ый", "ий", "ая",
  "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ом", "ем", "ам", "ям", "а", "я", "ы", "и", "у",
  "ю", "е", "о", "ь",
]

const LOOKALIKES: ReadonlyArray<readonly [string, string]> = [
  ["A", "\u0410"], ["a", "\u0430"], ["B", "\u0412"], ["b", "\u042C"],
  ["C", "\u0421"], ["c", "\u0441"], ["E", "\u0415"], ["e", "\u0435"],
  ["H", "\u041D"], ["h", "\u043D"], ["K", "\u041A"], ["k", "\u043A"],
  ["M", "\u041C"], ["m", "\u043C"], ["O", "\u041E"], ["o", "\u043E"],
  ["P", "\u0420"], ["p", "\u0440"], ["R", "\u0413"], ["r", "\u0433"],
  ["T", "\u0422"], ["t", "\u0442"], ["W", "\u0428"], ["w", "\u0448"],
  ["X", "\u0425"], ["x", "\u0445"], ["Y", "\u0423"], ["y", "\u0443"],
]

let rules: BannedTagRule[] = []

export function setBannedTagRules(next: BannedTagRule[]) {
  rules = next.map((rule) => ({
    term: normalizeTagToken(rule.term),
    matchMode: rule.matchMode,
  }))
}

export async function refreshBannedTags(): Promise<void> {
  const data = await api.get<{ rules: BannedTagRule[] }>(route("meCatalogBannedTags"))
  setBannedTagRules(data.rules ?? [])
}

export function bannedTagRejection(raw: string): string | null {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const flags = banFlags(tokens)
  const rejected = tokens.filter((_, index) => flags[index])
  if (rejected.length === 0) return null
  return `标签含受限词，不能保存：${rejected.join("、")}`
}

export function normalizeTagToken(raw: string): string {
  const trimmed = raw.normalize("NFKC").trim().replace(/^#+/, "").trim()
  return foldTagSeparators(foldLatinLookalikes(trimmed.toLowerCase()))
}

function foldTagSeparators(input: string): string {
  let out = ""
  let gap = false
  for (const ch of input) {
    if (ch === "\u00AD") continue
    if (isTagSeparator(ch)) {
      gap = out.length > 0
      continue
    }
    if (gap) {
      out += "_"
      gap = false
    }
    out += ch
  }
  return out
}

function isTagSeparator(ch: string): boolean {
  return /\s/.test(ch) || ch === "-" || ch === "_" || ch === "\u2010" || ch === "\u2011"
    || ch === "\u2012" || ch === "\u2013" || ch === "\u2014" || ch === "\u2212"
}

function tagIsBanned(raw: string): boolean {
  const token = normalizeTagToken(raw)
  if (!token) return false
  return rules.some((rule) => tokenMatches(token, rule))
}

function banFlags(tokens: string[]): boolean[] {
  const flags = tokens.map((token) => tagIsBanned(token))
  for (const rule of rules) {
    if (!rule.term.includes("_")) continue
    const width = rule.term.split("_").filter(Boolean).length
    if (width < 2 || tokens.length < width) continue
    for (let start = 0; start <= tokens.length - width; start++) {
      const joined = normalizeTagToken(tokens.slice(start, start + width).join(" "))
      if (tokenMatches(joined, rule)) {
        for (let index = start; index < start + width; index++) flags[index] = true
      }
    }
  }
  return flags
}

function tokenMatches(token: string, rule: BannedTagRule): boolean {
  if (rule.matchMode === "exact") return token === rule.term
  const stem = stemKey(rule.term)
  if ([...stem].length < 4) return token === rule.term
  return stemCovers(token, stem)
}

function stemCovers(token: string, stem: string): boolean {
  if (stemPrefix(token, stem)) return true
  if ([...stem].length >= 5 && stem.endsWith("к")) {
    return stemPrefix(token, `${stem.slice(0, -1)}ч`)
  }
  return false
}

function stemPrefix(token: string, stem: string): boolean {
  if (token === stem || token.startsWith(stem)) return true
  const parts = token.split("_").filter(Boolean)
  if (parts.some((part) => part === stem || part.startsWith(stem))) return true
  const width = stem.split("_").filter(Boolean).length
  if (width < 2 || parts.length < width) return false
  for (let start = 0; start <= parts.length - width; start++) {
    const joined = parts.slice(start, start + width).join("_")
    if (joined === stem || joined.startsWith(stem)) return true
  }
  return false
}

function stemKey(normalized: string): string {
  for (const suffix of INFLECTION_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      const stem = normalized.slice(0, normalized.length - suffix.length)
      if ([...stem].length >= 4) return stem
    }
  }
  return normalized
}

function foldLatinLookalikes(text: string): string {
  let out = ""
  let word = ""
  for (const ch of [...text, "\0"]) {
    if (isLatin(ch) || isCyrillic(ch)) {
      word += ch
      continue
    }
    if (word) {
      out += foldWord(word)
      word = ""
    }
    if (ch !== "\0") out += ch
  }
  return out
}

function foldWord(word: string): string {
  if (!containsMixedScript(word)) return word
  const latin = [...word].filter(isLatin)
  const cyrillic = [...word].filter(isCyrillic)
  if (latin.every((ch) => cyrillicTwin(ch))) {
    return [...word].map((ch) => cyrillicTwin(ch) ?? ch).join("")
  }
  if (cyrillic.every((ch) => latinTwin(ch)) && cyrillic.length < latin.length) {
    return [...word].map((ch) => latinTwin(ch) ?? ch).join("")
  }
  return [...word].map((ch) => cyrillicTwin(ch) ?? ch).join("")
}

function containsMixedScript(word: string): boolean {
  let latin = false
  let cyrillic = false
  for (const ch of [...word, "\0"]) {
    if (isLatin(ch)) latin = true
    else if (isCyrillic(ch)) cyrillic = true
    else if (latin && cyrillic) return true
    else {
      latin = false
      cyrillic = false
    }
  }
  return false
}

function cyrillicTwin(ch: string): string | undefined {
  return LOOKALIKES.find(([latin]) => latin === ch)?.[1]
}

function latinTwin(ch: string): string | undefined {
  return LOOKALIKES.find(([, cyrillic]) => cyrillic === ch)?.[0]
}

function isLatin(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")
}

function isCyrillic(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x0410 && code <= 0x044f) || code === 0x0451 || code === 0x0401
}
