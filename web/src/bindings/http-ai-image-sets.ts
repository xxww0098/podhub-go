import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type ImageSetCapability = components["schemas"]["AIImageSetCapability"]
export type ImageSet = components["schemas"]["AIImageSet"]
export type ImageSetRequest = components["schemas"]["AIImageSetRequest"]
export type AvailableImageSetCapability = Required<ImageSetCapability> & { available: true }

export function availableImageSetCapability(value: ImageSetCapability): value is AvailableImageSetCapability {
  return value.available === true && Boolean(value.account_id && value.model) && value.count === 3
    && Number.isSafeInteger(value.unit_microfen) && value.unit_microfen! > 0
    && Number.isSafeInteger(value.set_microfen) && value.set_microfen === value.unit_microfen! * value.count
}

const rawJSON = { responseBody: "json" as const }
export const imageSetsHttp = {
  capability: () => request<ImageSetCapability>("GET", route("aiImageSetsCapability"), undefined, {}, undefined, undefined, rawJSON),
  create: (body: ImageSetRequest, key: string) => request<ImageSet>("POST", route("aiImageSets"), body, { "Idempotency-Key": key }, 300_000, undefined, rawJSON),
  find: (key: string, id?: string) => request<ImageSet>("GET", id ? route("aiImageSetsById", { id }) : route("aiImageSets"), undefined, { "Idempotency-Key": key }, undefined, undefined, rawJSON),
}
