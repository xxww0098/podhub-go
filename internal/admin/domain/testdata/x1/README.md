# fixtures-X1

HEAD `7df856a`（v0.0.112）。请求体来自测试字面量；`hand/` 是按 serde 规则手算的成功 JSON，测试没有整包快照。

| 路径 | 来源 |
| --- | --- |
| `brief-minimal.txt` | `fixtures/ocr/brief-minimal.txt` |
| `ocr_prompt.ru.txt` | `src/platform/ocr_prompt.ru.txt` |
| `requests/post-row-staff-crud.json` | `tests/cloud/supplier_dbs.rs` `row_body` |
| `requests/price.json` | staff_crud 调价体 |
| `requests/put-ozon-ready-config.json` | `ready_config_body` 字面形状（标签与 revision 会被测试改写） |
| `requests/patch-prompt-chernovik.json` | `tests/cloud/prompt_authoring.rs` PATCH 体；`expectedRevision` 手算为 2 |
| `requests/prompt-publish.json` | 同测试 `{"revision":2}` |
| `hand/preview-chernovik.json` | preview 全文与两个 sha256 |
| `hand/post-row-staff-crud.response.json` | POST 行 201 |
| `hand/post-price.response.json` | 相对创建响应的变更字段 |
| `hand/get-detail-after-staff-row.json` | GET 详情 |
| `hand/get-prompt-diff-revision-2.json` | diff |
| `hand/patch-prompt.response.json` | PATCH |
| `hand/prompt-publish.response.json` | prompt publish |
| `hand/put-ozon-config.response.json` | PUT ozon-config |
| `hand/sync-empty.json` | 无候选 sync |

规格：`/opt/cursor/artifacts/spec-X1-supplier.md` 及 `spec-X1-01` / `02` / `03`。
