# X1 契约夹具

2026-10-30：商品说明与预览、对照夹具已迁移为三项商品事实 JSON。旧六行指令不再是有效输入；下面的 Rust 来源仅说明其余历史夹具。

历史提取来源为 Rust 版本 `7df856a`（v0.0.112），不是本仓库当前 HEAD。请求体来自当时测试字面量；`hand/` 是按 serde 规则手算的 JSON，不能当作真实接口执行记录。

当前消费方为 [domain 测试](../../supplier_prompt_test.go) 和 [HTTP 测试](../../../http/supplier_x1_test.go)。更新夹具时同时核对这些断言；历史来源路径仅用于溯源，不是本仓库可执行路径。

| 路径 | 来源 |
| --- | --- |
| `product-profile.json` | `fixtures/ocr/product-profile.json` |
| `requests/post-row-staff-crud.json` | `tests/cloud/supplier_dbs.rs` `row_body` |
| `requests/price.json` | staff_crud 调价体 |
| `requests/put-ozon-ready-config.json` | `ready_config_body` 字面形状（标签与 revision 会被测试改写） |
| `hand/preview-chernovik.json` | preview 全文与两个 sha256 |
| `hand/post-row-staff-crud.response.json` | POST 行 201 |
| `hand/post-price.response.json` | 相对创建响应的变更字段 |
| `hand/get-detail-after-staff-row.json` | GET 详情 |
| `hand/prompt-publish.response.json` | prompt publish |
| `hand/put-ozon-config.response.json` | PUT ozon-config |

原始规格名为 `spec-X1-supplier.md` 及 `spec-X1-01` / `02` / `03`，源文档未随此目录提供。当前契约以仓库 OpenAPI、实现和上述测试为准。
