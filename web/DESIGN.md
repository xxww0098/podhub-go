# 公开站设计约束

适用于 `src/features/site/` 的产品介绍单页。登录后的业务工作区遵循 [AGENTS.md](../AGENTS.md)，使用 `src/index.css` 的主题；公开站样式限定在 `.public-site`。

## 实现入口

- [public-site.tsx](src/features/site/public-site.tsx)：产品页、商品示例图片、选品 / 导图 / 提交流程。
- [public-site-shell.tsx](src/features/site/public-site-shell.tsx)：导航、页脚与共享区块。

[main.tsx](src/main.tsx) 导入 `public-site.css` 与 `public-site-responsive.css`。登录界面的独立样式放在 `src/features/account/login-screen.css`，不依赖官网覆盖层。

## 视觉规则

- 固定浅色：白底、冷灰分隔线，首屏文案与原商品照片分栏；不随工作区深色主题切换，不添加遮挡商品的浮层。
- 主操作、链接、焦点与选中态用品牌蓝。
- 正文使用 Inter Variable 与系统中文回退；等宽字体只用于代码、标识及数据。公开站字体与工作区的系统字体分别管理。
- 桌面内容容器占视口约 90%，不设旧版 1280px 上限；窄屏图片保持比例，操作可换行，触控目标至少 44px。保留跳转主内容、可见焦点与减少动画支持。
- 导航使用页内锚点，不显示版本号；商品图片是静态示例，不伪装成可浏览的商品目录。
- `.public-site a { color: inherit }` 的优先级高于按钮文字工具类，填色按钮须明确前景色，避免浅底浅字。

## 内容与验收边界

官网只保留产品介绍，登录与工厂登录分别通向 `/login` 和 `/supplier`。已删除的目录、定价、帮助、隐私及条款地址使用未匹配路径规则：未登录显示产品页，已登录进入工作台并检查工作空间资格。

首页预览、商品图和流程说明不能证明平台发布成功；能力结论以 [技术验证清单](../docs/precision-listing-verification.md) 为准。

[public-site.test.tsx](src/features/site/public-site.test.tsx) 固定登录入口与主要文案约束；[app-route.test.ts](src/lib/app-route.test.ts) 固定单页路由与登录权限边界。在 `web/` 可运行 `bun run test src/features/site/public-site.test.tsx src/lib/app-route.test.ts`。这些静态断言不能代替响应式浏览器检查或真实授权、写入及回读。
