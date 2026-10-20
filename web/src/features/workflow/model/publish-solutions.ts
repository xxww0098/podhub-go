import type { components } from "@/api/schema"
import { nativeSolution, type Solution } from "./publish-solutions-native"
import { adapterSolutions, controlSolutions, contractSolution, draftSkipSolutions, freezeSolutions, legacySkipSolutions, psdSolutions, requestSolutions } from "./publish-solutions-controls"
import { intentSolutions } from "./publish-solutions-intent"

export { nativeSolutions } from "./publish-solutions-native"
export type { NativeIssueKey, Solution } from "./publish-solutions-native"

/** Families retain their real producers' coordinates; no synthetic native codes. */
export const publishSolutions = {
  draft_skip: draftSkipSolutions, legacy_skip: legacySkipSolutions,
  freeze_refusal: freezeSolutions, request: requestSolutions,
  intent: intentSolutions, control: controlSolutions, psd: psdSolutions,
}

export function resolvePublishSolution(input: {
  platform: string; stage: string; code: string; family?: keyof typeof publishSolutions
}): Solution {
  // Even separate wire families cannot smuggle an unknown platform into actions.
  if (input.platform !== "ozon" && input.platform !== "wb") return contractSolution
  if (!input.family) {
    const native = nativeSolution(input.platform, input.stage, input.code)
    if (native) return native
    if (input.platform === "ozon" || (input.platform === "wb" &&
      ((input.stage === "identity" && input.code === "group_key_invalid") || (input.stage === "build" && input.code === "transport_unavailable")))) {
      for (const [stage, codes] of Object.entries(adapterSolutions)) {
        if (stage === input.stage) for (const [code, solution] of Object.entries<Solution>(codes)) if (code === input.code) return solution
      }
    }
    return contractSolution
  }
  const stages = {
    draft_skip: ["submit"], legacy_skip: ["submit"], freeze_refusal: ["freeze"],
    request: ["pre_dispatch", "submit", "save"], intent: ["pre_dispatch", "submit"],
    control: ["submit", "freeze", "validate", "preview", "repair", "build"], psd: ["render"],
  } satisfies Record<keyof typeof publishSolutions, readonly string[]>
  if (!Object.hasOwn(stages, input.family) || !stages[input.family].includes(input.stage)
    || (input.platform !== "ozon" && input.family !== "control")) return contractSolution
  for (const [code, solution] of Object.entries(publishSolutions[input.family])) {
    if (code === input.code) return solution
  }
  return contractSolution
}

export function issueSolution(issue: components["schemas"]["ListingIssue"], platform = "ozon"): Solution {
  const known = nativeSolution(platform, issue.phase, issue.code)
  if (!known || typeof issue.summary !== "string" || !issue.summary.trim()
    || typeof issue.remediation !== "string" || !issue.remediation.trim()
    || !Array.isArray(issue.allowed_actions) || !["row", "store"].includes(issue.scope)) return contractSolution
  return {
    ...known,
    // Cloud is the sole owner of classified issue copy and action permission.
    reason: issue.summary,
    // The stored row identifies the failed attempt; the write switch affects everyone.
    scope: known.scope === "platform" ? known.scope : issue.scope,
    steps: [issue.remediation, ...(known.actions.some((action) => issue.allowed_actions.includes(action)) ? known.steps : [])],
    actions: known.actions.filter((action) => issue.allowed_actions.includes(action)),
  }
}

export function solutionScope(scope: Solution["scope"]): string {
  switch (scope) {
    case "row": return "仅此商品行"
    case "platform": return "所有用户向 Ozon 发送商品均受影响"
    case "store": return "当前店铺及绑定该店铺的商品"
    case "block": return "本次尝试的整块商品；其它货号也随本块被拒绝，不据此判定它们冲突"
  }
}
