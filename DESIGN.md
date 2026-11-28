# FduNav Design

## Product

面向复旦学生的个人校园桌面助手。新增主动助手：用户可控制的持续留意，而不是不断弹窗的聊天机器人。

## North Star

用户能在十秒内判断助手是否在运行、留意什么、刚刚为什么提醒，并随时停止。

## Visual direction

延续现有浅/深色桌面设置：细边框、克制的强调色、系统中文字体。已有侧栏与设置面板是 canonical owner；不重构现有导航。避免装饰性大卡片与营销口吻。

## Tokens

Runtime source of truth: `src/renderer/src/styles/tokens.css` 的 `--color-bg-surface`、`--color-text-primary`、`--color-text-muted`、`--color-border-default`、`--color-accent` 等已有 CSS 变量。新样式消费现有变量，不引入全站 token 迁移。

## Components

设置导航由 App.tsx 持有；主动助手设置、监控表单、关注/活动列表统一由 AssistantPanel.tsx 持有。按钮、输入、开关继承既有设置风格。活动详情使用原生 details，避免另造弹窗焦点规则。

## Interaction

默认关闭。保存成功才更新服务端状态；失败保留输入并允许重试。删除先展示行内确认。切换账号卸载面板，异步结果按生命周期屏蔽。系统提醒点击打开主动助手；关注项显式标为已读。运行/等待预算/失败/无需处理分别展示。

## Accessibility

原生表单、可见标签、键盘可达、focus-visible、状态播报、窄屏重排，深浅主题共用变量。无新增动画，遵循系统减少动态效果设置。

## Verification

类型检查、构建、Node 单元测试；真实 Electron 与浏览器隔离数据状态检查，截图与局限记录在 docs/proactive-agent-verification.md。
