import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type SubscriptionView = components["schemas"]["SubscriptionView"]
export type SubscriptionPeriod = components["schemas"]["SubscriptionPeriod"]
export type SubscriptionRequest = components["schemas"]["SubscriptionQuoteRequest"]
export type SubscriptionQuote = components["schemas"]["SubscriptionQuote"]
export type SubscriptionOrder = components["schemas"]["SubscriptionOrder"]

export const subscriptionHttp = {
  view: () => api.get<SubscriptionView>(route("billingSubscription")),
  quote: (request: SubscriptionRequest) => api.post<SubscriptionQuote>(route("billingQuotes"), request),
  confirm: (quote_id: string, cancel_pending: boolean) =>
    api.post<SubscriptionView>(route("billingSchedule"), { quote_id, cancel_pending }),
  order: (quote_id: string, accepted_version: string) =>
    api.post<components["schemas"]["SubscriptionOrderBrief"]>(route("billingOrders"), { quote_id, accepted_version }),
  getOrder: (public_id: string) => api.get<SubscriptionOrder>(route("billingOrdersByPublicId", { public_id })),
}
