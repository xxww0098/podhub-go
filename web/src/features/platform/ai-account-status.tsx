import { StateChip } from "@/components/state-chip"
import type { StateTone } from "@/lib/receipt-state"

export type AiConnectionState = "idle" | "ok" | "missing" | "failed"

const connectionMark: Record<AiConnectionState, { label: string; tone: StateTone }> = {
  idle: { label: "尚未测试", tone: "idle" },
  ok: { label: "连接正常", tone: "good" },
  missing: { label: "目录未列出", tone: "unknown" },
  failed: { label: "未通过", tone: "bad" },
}

export function AiConnectionChip({ state }: { state: AiConnectionState }) {
  const mark = connectionMark[state]
  return <StateChip status={state} label={mark.label} tone={mark.tone} />
}
