import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type SupplierOcrTestInput = components["schemas"]["ArtworkOcrTestInput"]
export type SupplierOcrTestResult = components["schemas"]["ArtworkOcrTestResult"]
export const supplierOcrTestsHttp = {
  upload: (id: string, input: SupplierOcrTestInput) => api.post<components["schemas"]["ArtworkOcrTestUploadData"]>(route("adminAiOcrTestsByIdUpload", { id }), { input }),
  confirm: (id: string, input: SupplierOcrTestInput, upload_ticket: string) => api.post(route("adminAiOcrTestsByIdConfirm", { id }), { input, upload_ticket }),
  run: (id: string, input: SupplierOcrTestInput, upload_ticket: string) => api.post<SupplierOcrTestResult>(route("adminAiOcrTestsById", { id }), { input, upload_ticket }, 150_000),
  get: (id: string) => api.get<SupplierOcrTestResult>(route("adminAiOcrTestsById", { id })),
}
