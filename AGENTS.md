<!-- codebase-memory-mcp:start -->
结构探索、调用链与迁移影响分析使用已安装的 `codebase-memory` skill；核查依赖文件的索引覆盖，缺口直接读源码。
<!-- codebase-memory-mcp:end -->

@/Users/xxww/.codex/RTK.md

把本项目当新工程改，允许破坏性变更，不旧兼容。

## 项目结构与迁移

本项目是多租户、多电商平台 SaaS。目录、分层与依赖规则以 [项目树](docs/architecture-tree.md) 为准，系统约束见 [架构约束](docs/architecture.md)。

- 公共业务按 `internal/<域>` 组织；租户、成员、计费、队列与媒体统一维护。具体 Seller 出口放 `internal/seller/<平台>`，前端上架适配放 `web/src/features/workflow/platforms/<平台>`。
- `internal/platform` 只放技术基础设施；`web/src/features/platform` 是 SaaS 管理配置。电商平台协议归具体适配器。
- `cmd` 只调用 `internal/app`；跨域只依赖更低层级的 `contract`，层级在 `tests/archtest/arch_test.go` 登记。域内目录按实际需要建立，不建空层。
- 队列 DTO、错误与纯规则归 `queue/contract` 或 `queue/domain`，数据库实现归 `queue/repo`。使用方在 `ports.go` 声明所需操作，由 `internal/app` 显式传入；禁止通过可变全局函数、`init` 回填或空白导入注册业务依赖。
- 迁移同时更新调用方、测试、夹具、生成配置与文档；删除旧路径，不留转发包、占位目录或兼容壳。生成物从源配置生成，不手改。
- 迁移后运行 `go test ./tests/archtest` 和受影响测试，编译全部 Go 包；前端迁移检查 TypeScript 与构建。不得扩大架构基线掩盖违规，跳过的数据库或外部链路验证须明确说明。
- Rust 源码统一在 `rust/crates`，WASM 产物统一在 `wasm/dist`。构建消费已提交产物；源码或构建输入变化后用 `make wasm` 重建，不能只改指纹清单。

## 界面密度

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

业务页面不显示顶部静态页面标题和重复介绍，页面名由侧栏定位；详情回退保留顶部导航。内容区优先放筛选、操作和数据；保留必要字段标签、错误与未知状态。
默认图标侧栏与单层顶栏，桌面工作区约占视口 90%；操作尽量横向平铺，减少多层工具栏、居中限宽和人为留白。窄屏安全换行，保留可访问的全部操作。

## 精铺功能准入

新增精铺功能前必须先做技术验证，通过后才能加入产品界面。视频演示、参考站菜单或表单、官方接口文档和模拟测试不能单独作为真实能力已跑通的依据；参考优先级不代表验证通过。

- 内部能力验证真实输入、输出及持久化；外部能力验证授权、实际调用、结果回读及失败处理。
- 分清「本地构件已验证」「外部链路待验证」「功能已通过」，不要把预览、请求受理或队列完成标成商品已在售。
- 未通过的能力不先放占位入口或成功演示。当前证据与准入结论见 [技术验证清单](docs/precision-listing-verification.md)。

## 前端技术栈

产品界面与交互必须实现在 `web/src` 的真实 React 页面、组件和 API 接线中；HTML 预览及测试夹具仅用于验收，不能代替前端交付。

1. UI 组件用 shadcn/ui 的 Nova 风格
2. 图标用 Lucide
3. 动画用 Motion
4. 分栏布局用 react-resizable-panels
5. 拖拽用 dnd-kit
6. 状态管理用 Zustand

## 本地验收账号

以下账号属于本地开发数据库，密码均为 `123123123`。

| 角色 | 邮箱 | 登录入口 | 工作空间 / 授权 |
| --- | --- | --- | --- |
| 平台超级管理员 / `Test` 所有者 | `admin@pod.com` | `/admin` | `Test` 的 `owner` |
| 平台管理员 | `platform-admin@pod.com` | `/admin` | 自有工作空间；平台角色为 `admin` |
| 工作空间主管 | `manager@pod.com` | `/login` | `Test` 的 `manager` |
| 工作空间成员 | `user@pod.com` | `/login` | `Test` 的 `member`；当前切到 `audit-test` |
| 工厂成员 | `factory@pod.com` | `/supplier` | 本地验收工厂（含履约授权） |

`manager@pod.com` 和 `user@pod.com` 还各自拥有注册时创建的个人工作空间。`manager@pod.com` 的当前工作空间是 `Test`；`user@pod.com` 的 `active_org_id` 当前指向 `audit-test`（其 owner），要验收 `Test` 成员权限需在顶部切回 `Test`。这两个 `Test` 成员关系由历史本地测试数据直接创建；当前邀请创建、接受、拒绝与撤销已接入真实接口。

### 角色模型

角色只在三个作用域定义，每个账号在每个作用域只有一个角色；履约、商品负责人是授权，不是角色。

| 作用域 | 角色 | 说明 |
| --- | --- | --- |
| 平台 | `super_admin` / `admin` / `user` | 平台后台权限；`account_kind='supplier'` 的账号固定 `user` |
| 工作空间 | `owner` / `manager` / `member` | `organizations` 内的成员角色 |
| 工厂工作空间 | `member` | 工厂成员；成员关系本身即角色，没有其他工厂角色 |

- 工厂工作空间不是 `organizations` 工作空间：工厂和首个登录账号由平台超级管理员在“平台管理 > 工厂管理”创建，工厂不能自行注册；工厂侧没有成员管理入口。
- `sc_factories` 保存独立工厂，`sc_factory_members` 保存工厂成员；`sc_sources.factory_id` 把商品库绑定到工厂，一家工厂可绑定多本商品库。历史未绑定库可在商品库管理中补绑；系统保留的 `src_unassigned` 不能绑定，不得通过编辑工厂资料更换成员。
- 工厂成员可在公开入口 `/supplier` 登录；未绑定商品库或未授予履约权限时显示等待状态。履约授权由 `sc_source_fulfillers.status='active'` 按商品库记录，每个来源最多一个 active；接单、拒单、发货需有相应授权。
- 商品负责人由 `sc_catalog_managers.status='active'` 记录，是平台账号的源级商品维护授权，不是工厂角色。
- `factory@pod.com` 是「本地验收工厂」的工厂成员，同时持有 active 履约授权，因此可以完整验收工厂工作台。
- 工厂和首个账号通过 `/admin?settings=supplier-accounts` 开通，初始密码仅回显一次；商品库页面只绑定已有工厂。履约权限需单独调用 `POST /api/admin/supplier-dbs/{source_id}/fulfillers`；商品负责人通过 `/api/admin/supplier-dbs/{source_id}/catalog-managers` 授予。停用或解绑工厂成员只撤销该工厂各商品库的有效履约授权，不影响其他工厂。

角色定义与数据库约束见 [账号与权限模型](docs/architecture/account-permission-model.md)。
