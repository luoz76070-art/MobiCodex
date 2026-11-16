# Design

scripts/helpers/synthetic-app.mjs 持有原虚构数据、白名单 page.route、固定时钟、隔离 context 和真实本地 SSE；导入不构建、不启服务或浏览器。
README 模式保留原 Codex 缓存和迁移键。导航模式只预置连接和显示设置，不预置导航；初始化仅一次，刷新保留 App 自己写入的 scope/version 导航和草稿。
检查从真实顶栏、Agent 行和会话行点击；系统返回只派发可取消 product-back，并观测 defaultPrevented。设置按实际 .settings-sheet.open 判断；导航状态只读，不用写 storage 替代交互。
useAttention 仅原生平台注册 Attention.open，App 未导出网页通知方法；g 步截图并明确跳过。提供同一 CC Desk key/title、列表和 SSE 数据，供后续原生验收使用。
断言失败保留截图并退出非零；资源在 finally 释放。额外测试非根页刷新，以排除初始化覆盖导航的假阳性。
