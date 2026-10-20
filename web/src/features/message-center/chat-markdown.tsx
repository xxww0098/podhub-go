import type { ReactNode } from "react"

// Ozon chat bodies are Markdown-lite: `**bold**`, `[text](https://…)` and
// newlines. Render exactly those three; anything else stays literal text.
const LINK = /!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
const BOLD = /\*\*([^*]+)\*\*/g

function renderBold(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  BOLD.lastIndex = 0
  while ((match = BOLD.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    out.push(
      <strong key={`${keyPrefix}b${match.index}`} className="font-semibold">
        {match[1]}
      </strong>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function ChatMarkdown({ text }: { text: string }) {
  // Ozon digests use `* ` line bullets; there is no list markup to render
  // them, so print the glyph they meant.
  const source = text.replace(/^(\s*)\*\s+/gm, "$1• ")
  const out: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  LINK.lastIndex = 0
  while ((match = LINK.exec(source)) !== null) {
    if (match.index > last) {
      out.push(...renderBold(source.slice(last, match.index), `t${match.index}-`))
    }
    // `![alt](url)` is an image tag — keep it as a labelled link, not a dead
    // exclamation glued to the anchor.
    const isImage = match[0].startsWith("!")
    const label = match[1].trim() || (isImage ? "图片" : match[2])
    out.push(
      <a
        key={`l${match.index}`}
        href={match[2]}
        target="_blank"
        rel="noreferrer"
        className="break-all text-brand-ink underline decoration-brand-ink/40 underline-offset-2 hover:decoration-brand-ink"
      >
        {renderBold(label, `a${match.index}-`)}
      </a>,
    )
    last = match.index + match[0].length
  }
  if (last < source.length) out.push(...renderBold(source.slice(last), "tail-"))
  return <>{out}</>
}
