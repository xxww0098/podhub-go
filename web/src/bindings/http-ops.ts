/**
 * Ops HTTP wire: 发货 / 退货 / 口碑 / 供货, 商品, 客服 and 概览.
 *
 * Every thunk is one Cloud `/api/ops/...` route.
 * Screens import `opsHttp` directly.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type {
  ConsoleRefreshMetricsResponse,
  ConsoleSnapshot,
  MessageCenterHistoryRequest,
  MessageCenterHistoryView,
  MessageCenterInboxRequest,
  MessageCenterInboxView,
  MessageCenterSendRequest,
  MessageCenterSendView,
  OpsCancellationsListRequest,
  OpsCancellationsListView,
  OpsReturnsListRequest,
  OpsReturnsListView,
  OpsVoiceQuestionsRequest,
  OpsVoiceQuestionsView,
  OpsVoiceReviewsRequest,
  OpsVoiceReviewsView,
  ProductMetricsRequest,
  ProductMetricsSnapshot,
  ProductMonitorRequest,
  ProductMonitorSnapshot,
  ProductMutationCommand,
  ProductMutationResponse,
  ProductPromotionsRequest,
  ProductPromotionsView,
  ProductWarehousesRequest,
  ProductWarehousesView,
  ReconcileOperationsResponse,
  ShippingListRequest,
  ShippingListView,
  SupplyListRequest,
  SupplyListView,
  SupplyWarehouseStocksRequest,
  SupplyWarehouseStocksView,
} from "./commands"

export const opsHttp = {
  // 运维 screens: one Cloud route per screen, the Store UUID in the body
  // The request DTOs are the route's own schema, so
  // the thunk is the POST and nothing else.
  productsSync: (request: ProductMonitorRequest) =>
    api.post<ProductMonitorSnapshot>(route("opsProductsSync"), request),
  productsSyncMetrics: (request: ProductMetricsRequest) =>
    api.post<ProductMetricsSnapshot>(route("opsProductsMetrics"), request),
  productsListWarehouses: (request: ProductWarehousesRequest) =>
    api.post<ProductWarehousesView>(route("opsProductsWarehouses"), request),
  productsListPromotions: (request: ProductPromotionsRequest) =>
    api.post<ProductPromotionsView>(route("opsProductsPromotions"), request),
  // The command *is* the body: Cloud keys the write ledger on its
  // `operation_id`, so a retry of the same command replays instead of
  // sending a second Seller write.
  productsMutate: (command: ProductMutationCommand) =>
    api.post<ProductMutationResponse>(route("opsProductsMutate"), command),
  opsReturnsList: (request: OpsReturnsListRequest) =>
    api.post<OpsReturnsListView>(route("opsReturnsList"), request),
  opsCancellationsList: (request: OpsCancellationsListRequest) =>
    api.post<OpsCancellationsListView>(route("opsReturnsCancellations"), request),
  opsShippingList: (request: ShippingListRequest) =>
    api.post<ShippingListView>(route("opsShippingList"), request),
  opsSupplyList: (request: SupplyListRequest) =>
    api.post<SupplyListView>(route("opsSupplyOrders"), request),
  opsSupplyWarehouseStocks: (request: SupplyWarehouseStocksRequest) =>
    api.post<SupplyWarehouseStocksView>(route("opsSupplyWarehouseStocks"), request),
  opsVoiceListReviews: (request: OpsVoiceReviewsRequest) =>
    api.post<OpsVoiceReviewsView>(route("opsVoiceReviews"), request),
  opsVoiceListQuestions: (request: OpsVoiceQuestionsRequest) =>
    api.post<OpsVoiceQuestionsView>(route("opsVoiceQuestions"), request),
  messageCenterInbox: (request: MessageCenterInboxRequest) =>
    api.post<MessageCenterInboxView>(route("opsMessageCenterInbox"), request),
  messageCenterHistory: (request: MessageCenterHistoryRequest) =>
    api.post<MessageCenterHistoryView>(route("opsMessageCenterHistory"), request),
  messageCenterSend: (request: MessageCenterSendRequest) =>
    api.post<MessageCenterSendView>(route("opsMessageCenterSend"), request),
  consoleGetSnapshot: () => api.get<ConsoleSnapshot>(route("opsConsoleSnapshot")),
  consoleRefreshMetrics: () =>
    api.post<ConsoleRefreshMetricsResponse>(route("opsConsoleRefreshMetrics")),
  // Reconciliation is Cloud's reconciler over this Workspace's whole Seller write
  // ledger; there is no per-Store variant, and the
  // route takes no body.
  consoleReconcileActiveWorkspace: () =>
    api.post<ReconcileOperationsResponse>(route("opsConsoleReconcile")),
}
