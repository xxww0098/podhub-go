/** Assembly root: local preview adapters and the separate final S16 send capabilities. */
import { createOzonAdapter, createOzonSendCapability, type OzonFreezeCore } from "./ozon"
import { createPlatformRegistry } from "./publish"
import { createWbAdapter, type WbPreviewCore, type WbIssuePresenter } from "./wb/adapter"

export function createListingPlatforms(core: OzonFreezeCore & WbPreviewCore, describeWbIssue: WbIssuePresenter,
  onWbDiagnostic?: Parameters<typeof createWbAdapter>[2]) {
  return createPlatformRegistry({ ozon: createOzonAdapter(core), wb: createWbAdapter(core, describeWbIssue, onWbDiagnostic) })
}

/** Final queue assembly. Preview-only platforms have no send capability. */
export function createListingSendCapabilities(options: Parameters<typeof createOzonSendCapability>[0]) {
  return Object.freeze({ ozon: createOzonSendCapability(options) })
}
