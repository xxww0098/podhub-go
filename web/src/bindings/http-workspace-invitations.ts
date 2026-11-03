import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { WorkspaceInvitationCreatedView } from "./commands"

export function createWorkspaceInvitation(email: string, role: string): Promise<WorkspaceInvitationCreatedView> {
  return request("POST", route("invitations"), { email, role }, {}, undefined, undefined, { responseBody: "json" })
}
