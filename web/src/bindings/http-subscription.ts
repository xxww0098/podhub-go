import { request } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

export type SubscriptionView = components["schemas"]["SubscriptionView"]
export type SubscriptionPeriod = components["schemas"]["SubscriptionPeriod"]
export type SubscriptionRequest = components["schemas"]["SubscriptionQuoteRequest"]
export type SubscriptionQuote = components["schemas"]["SubscriptionQuote"]
export type SubscriptionOrder = components["schemas"]["SubscriptionOrder"]

export const subscriptionHttp = {
  view: () => request<SubscriptionView>("GET", route("billingSubscription"), undefined, {}, undefined, undefined, { responseBody: "json" }),
  quote: (body: SubscriptionRequest) => request<SubscriptionQuote>("POST", route("billingQuotes"), body, {}, undefined, undefined, { responseBody: "json" }),
  confirm: (quote_id: string, cancel_pending: boolean) =>
    request<SubscriptionView>("POST", route("billingSchedule"), { quote_id, cancel_pending }, {}, undefined, undefined, { responseBody: "json" }),
  order: (quote_id: string, accepted_version: string) =>
    request<components["schemas"]["SubscriptionOrderBrief"]>("POST", route("billingOrders"), { quote_id, accepted_version }, {}, undefined, undefined, { responseBody: "json" }),
  getOrder: (public_id: string) => request<SubscriptionOrder>("GET", route("billingOrdersByPublicId", { public_id }), undefined, {}, undefined, undefined, { responseBody: "json" }),
}
