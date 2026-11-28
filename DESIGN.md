---
version: alpha
name: FduNav
description: 为复旦同学开发的安静、可控、可核查的校园桌面助手。
colors:
  primary: "#3567d6"
  background: "#fefefe"
  text: "#212733"
  muted: "#676a71"
  border: "#d6d9df"
typography:
  sans:
    fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
  mono:
    fontFamily: '"Cascadia Code", Consolas, monospace'
rounded:
  DEFAULT: "0.875rem"
  sm: "0.625rem"
  md: "0.875rem"
spacing:
  section-gap: "1.5rem"
  control-height: "2.75rem"
components:
  button: {}
  input: {}
  monitor: {}
  activity: {}
---

# FduNav Design System

## Overview

### Creative North Star

像一份放在书桌上的校园事务清单：只标记值得留意的变化，每条都能核对来由。用户能在十秒内判断助手是否开启、留意什么、为什么提醒，并随时停止。

### Product context and register

服务复旦学生选课、处理邮件和安排校园事务，目标用户来自本次产品要求。中文界面，桌面常驻和托盘运行；当前新增界面为产品设置，不使用营销式大卡片、装饰性图表或无关品牌重塑。强调“少打扰、可控制、可核查”。

Runtime tokens 的唯一来源是 `src/renderer/src/styles/tokens.css`。此文档镜像已使用的浅色值；深色值继续由该文件 `light-dark()` 提供，不生成或复制另一套运行时变量。新增 CSS 仅消费已有变量。

## Colors

浅色强调色 `primary` 对应 `--color-accent`；背景、正文、辅助文字、边框分别映射 `--color-bg-surface`、`--color-text-primary`、`--color-text-muted`、`--color-border-default`。深色、禁用和焦点颜色沿用同一文件。关注项只用左侧强调线，不用全屏强色。

## Typography

系统中文字体优先可读性，标题 1.375rem、分组标题 1.1875rem、正文 1rem、辅助信息 .875rem。继承现有字号与行高变量；来源引用可混排英文和数字，长名称换行，不能依赖悬停查看全文。

## Layout

继承 App.tsx 的设置侧栏和滚动面板。监控、活动使用纵向清单，以分隔线表达层级。680px 以下操作行重排，表单控件可完整显示，390px 验证不产生水平滚动。状态区域保留固定文字空间，刷新保留已有数据。

## Elevation & Depth

沿用既有背景层、细边框；不为每条活动增加阴影。确认、表单与说明使用 subtle 背景，不新增模态层或遮罩。

## Shapes

表单和按钮沿用 `rounded.DEFAULT`，输入边框沿用既有 control token。分割线和关注左线表达边界，避免多层圆角容器嵌套。

## Components

### Foundational visual states

按钮有 hover、focus-visible、active、disabled；加载与保存用可朗读文字，失败保留原输入。所有开关与状态都有中文可见名称。新增界面不依赖动画。

### Buttons and actions

“添加监控”“保存监控”使用强调色，普通操作中性。删除和清空先显示包含对象名称的行内确认；保存中防重复提交，失败可重试。操作控件至少 44px 高。

### Navigation and data display

App.tsx 持有设置导航；AssistantPanel.tsx 持有监控表单与活动详情。系统通知打开相同面板；待关注和全部活动是显式筛选。活动由后台真实状态驱动，不伪造完成结论。

### Forms and overlays

监控创建与编辑共用一个内联表单；前后端共享校验，原生 select/number/checkbox 负责键盘行为。textarea 具有足够初始高度与内部滚动。详情使用原生 details，不另外实现模态焦点规则。反馈使用持久 live region。

### Iconography

沿用 Icon.tsx 的线性 SVG 系统；主动助手设置使用既有 processor 图标，不新建图标体系。

### Motion

新增界面无动画，不引入减少动态效果模式下的移动。继承上游主题与控件行为。

### Content and data visualization

文案描述用户的关注目标和结果，不展示 EventBus 等内部名词。解释应用退出和睡眠后的运行边界、相关资料发送到已配置模型、每日次数上限。来源、截断、读取失败都可以核查。

## Do's and Don'ts

- 只在有具体变化时提醒，区分未完成与无需处理。
- 复用已有侧栏、主题变量和设置操作语言。
- 不声称退出后仍可唤醒电脑，不给后台开放写工具。
- 不把完整请求、邮件正文或连接凭据展示成活动日志。
