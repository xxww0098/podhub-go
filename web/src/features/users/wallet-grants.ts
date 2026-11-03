import type { AdminUsersOverview, WalletTopupsData } from "@/bindings/commands"
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, topupCentsFromYuan } from "@/lib/money"

/** The server clips a grant note to this many characters. */
export const GRANT_NOTE_MAX = 200

/** 元 typed by the admin → 分 inside the grantable range, else `null`. */
export function grantCentsFromYuan(input: string): number | null {
  const cents = topupCentsFromYuan(input)
  return cents !== null && cents >= MIN_TOPUP_CENTS && cents <= MAX_TOPUP_CENTS ? cents : null
}

export type GrantAttempt = {
  operationId: string
  workspaceUuid: string
  amountCents: number
  note: string
}

/**
 * The attempt a submit belongs to. The same workspace, amount and note as the
 * unfinished `previous` attempt is a retry and keeps its `operation_id`, so the
 * server replays instead of crediting twice; anything else is a new grant and
 * mints a new id. The caller drops `previous` once the grant succeeded.
 */
export function grantAttemptFor(
  previous: GrantAttempt | undefined,
  workspaceUuid: string,
  amountCents: number,
  note: string,
  mintId: () => string = () => crypto.randomUUID(),
): GrantAttempt {
  const trimmed = note.trim()
  if (
    previous &&
    previous.workspaceUuid === workspaceUuid &&
    previous.amountCents === amountCents &&
    previous.note === trimmed
  ) {
    return previous
  }
  return { operationId: mintId(), workspaceUuid, amountCents, note: trimmed }
}

/** Directory with one workspace's available/held replaced by a fresh wallet read. */
export function applyWalletToWorkspace(
  overview: AdminUsersOverview | undefined,
  workspaceUuid: string,
  wallet: Pick<WalletTopupsData, "available_microfen" | "held_microfen">,
): AdminUsersOverview | undefined {
  if (!overview || !overview.workspaces.some((workspace) => workspace.uuid === workspaceUuid)) {
    return overview
  }
  return {
    ...overview,
    workspaces: overview.workspaces.map((workspace) =>
      workspace.uuid === workspaceUuid
        ? {
            ...workspace,
            wallet_available_microfen: wallet.available_microfen,
            wallet_held_microfen: wallet.held_microfen,
          }
        : workspace,
    ),
  }
}
