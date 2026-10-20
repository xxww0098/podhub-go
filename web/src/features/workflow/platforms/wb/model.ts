/** Browser preview identity only; native config and protocol live at the ABI boundary. */
import type { WbProductConfig, WbSchemaHandle, WbCardGroup } from "@/listing-core/wb-types"

export type WbBuildInput = {
  /** Resident-only lookup checks the current account/workspace/material lease. Never fetches. */
  material(): WbSchemaHandle
  groups: readonly { key: string; config: WbProductConfig }[]
}
export type WbBody = { group: WbCardGroup; uploadBytes: readonly number[] }
