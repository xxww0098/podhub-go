import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { downloadGrant, readPresignedObject } from "./object-download"

export function verifySupplierProductMedia(productId: string) {
  return api.post<components["schemas"]["SupplierMediaVerificationData"]>(
    route("mediaSupplierProductsByProductIdVerify", { product_id: productId }),
  )
}

export async function downloadSupplierTemplate(
  productId: string,
  digest: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const grant = await downloadGrant(
    route("mediaSupplierProductsByProductIdTemplatesByDigest", { product_id: productId, digest }),
    10 * 60 * 1000,
  )
  if (grant.sha256.toLowerCase() !== digest.toLowerCase()) {
    throw Object.assign(new Error("供应商 PSD 校验标识不一致"), { code: "workflow_template_digest_mismatch" })
  }
  return readPresignedObject(grant, 10 * 60 * 1000)
}
