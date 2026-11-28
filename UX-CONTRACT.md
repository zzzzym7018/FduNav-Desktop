# 主动助手交互约定

- 设置 → 主动助手是配置与活动记录的唯一入口；系统通知和助手入口使用同一面板。
- 默认关闭、账号隔离，开关保存后生效；未登录时说明原因，可查看运行边界。
- 空列表给出可执行的创建入口；加载/失败/重试有文字状态，已有数据刷新时保持可见。
- 创建/修改使用同一内联表单；保存中防止重复提交，失败不清除草稿；取消返回列表；成功焦点回到监控列表。
- 删除确认显示监控名称，确认后回列表；清空活动需二次行内确认。
- 每次活动能看原因、结论、来源、覆盖不足与错误。未读关注不会因打开设置自动消失；用户主动标为已读。
- 页面刷新不擅自调用模型，手动立即检查也受总开关、账号、权限和每日预算约束。
- UI 不声称退出后可运行；不提供尚未实现的搜索/自动写操作权限。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | 原生 select；遵循 GeneralPanel.tsx | 本文件与 AssistantPanel.tsx | 原生 source 选择 | 键盘与 Electron 测试 |
| Date | 原生日期控件；遵循既有 CalendarEventDialog.tsx | 既有 calendar 流程；新增仅展示时间 | 本地时间文字、既有原生输入 | 日期格式检查 |
| Form | AssistantPanel.tsx + shared/assistant.ts | 共享校验与主进程再次校验 | 创建与编辑同一表单 | 全流程回归 |
| Scrollbar | styles/base.css | 既有 Electron 页面滚动 | 窄屏自然纵向滚动 | 窄屏截图 |
| Toast | AssistantPanel.tsx 持久 role=status / alert | 已完成的 IPC 结果 | 成功与失败文字 | live region 与失败恢复 |
| CRUD | AssistantPanel.tsx | AssistantRuntime 与 AssistantStore | 行内创建、编辑、删除确认 | 全流程回归 |

## Authoritative sources

功能授权与范围来自当前用户要求；实现边界、权限、预算、生命周期与保留政策见 `docs/proactive-agent.md`。插件扩展沿用上游；后台助手主进程接口不加入插件服务覆盖表。

## Verification scope

本次严格静态审查覆盖新增 assistant 界面。既有页面审查单独记录，不将其旧问题伪报为本次已修复。原生 number/select/checkbox 的键盘行为保留；前后端同一校验函数；错误不会清除草稿。取消编辑恢复分组标题焦点；删除与清空使用行内二次确认。
