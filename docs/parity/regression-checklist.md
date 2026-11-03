# schema_revision 专项回归清单

本清单只覆盖字段顺序引起的版本误报，不是全仓路由覆盖清单。2026-10-16 的故障背景、实现差异和历史测试结果集中在 [schema-revision-parity.md](schema-revision-parity.md)。

修改字段快照、版本判定或冻结路径时，核对以下行为：

- 同字段、不同顺序得到相同版本号；快照仍保留展示顺序。
- 缓存刷新后语义未变，已填商品能改绑当前版本并继续，不新增版本记录。
- 真正新增必填且商品缺值时拒绝，并指出字段；已有值则继续。
- 类型、选项、约束变化仍改变版本号。
- HTTP 响应使用 `accepted_schema_revisions`；WASM 内部字段保持其自身契约。

```sh
go test -count=1 -timeout 120s ./internal/listing/core/ ./internal/listing/submit/
```

旧哈希双算已在现有实现中，不再列为待开发要求。是否移除 `LegacyRevision` 由 [决策登记 O3](../decisions.md) 跟踪；新工作按根 [AGENTS.md](../../AGENTS.md) 执行，不从历史对拍推导旧兼容要求。本文未重新运行上述测试。
