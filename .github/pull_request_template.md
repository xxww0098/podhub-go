## 做了什么

-

## 结果一致性

- [ ] 本次没有改变对外的输出、状态或数据；或每一处流程优化都写明了：改了哪个流程、结果为什么不变，并附上结果一致性测试证据
- [ ] 无法证明一致的差异已单独列出，并明确交给用户决定。没有此类差异时在描述里写「无」
- [ ] `OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 的解析语义未变，只在 `internal/platform/config` 读一次，代码没有第二套解析
- [ ] 没有在配置了 R2 的环境启用媒体桶删除
- [ ] 没有连接生产数据库、Ozon、R2 或模型供应商；压测只使用 Mode R
- [ ] River 与 goose 的差异已写进 `docs/parity/queue-and-migration-differences.md`，每一项有结果一致性测试；无法证明的点单独列出。oapi-codegen 仍是待决定，没有被写成已选定替换

## 如何验证

-

## 需要用户决定

-
