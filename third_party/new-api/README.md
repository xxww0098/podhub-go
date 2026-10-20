# new-api 计费公式副本

来源提交、逐字文件和适配清单在 [PROVENANCE.md](PROVENANCE.md)。

- 许可证：GNU AGPL-3.0（`LICENSE`）。`NOTICE` 要求在界面保留 “Frontend design and development by New API contributors.” 以及指向 https://github.com/QuantumNous/new-api 的链接。本仓库没有日志页，界面署名留到有前端的那一次。
- 用户已接受 AGPL-3.0 第 13 条。把这些文件编进对外服务时，要向远程用户提供对应源码。
- 公式文件与上游 `3e2ce2c` 同路径字节一致。适配放在 `adapter_*.go` 和 `service/quota_formula.go`，不改公式函数体。
- 本目录不写 `user_wallets`，也不把 new-api 的负余额接到 podhub。
