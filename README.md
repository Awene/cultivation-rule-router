# 修仙规则路由 · Cultivation Rule Router

SillyTavern 扩展：在生成前用一个轻量（flash）模型**智能判断该激活哪些"规则类"世界书条目**，把命中的规则（经 EJS/宏求值后）注入提示词，再交给主模型生成。目标是在不脱离 ST、不修改用户手动开关的前提下，让主模型每回合只看到**相关**的规则。

## 工作原理

```
玩家发送 → GENERATION_AFTER_COMMANDS 拦截
  1. 读规则世界书条目 + 其开启状态(disable)          —— loadWorldInfo（用户开关 = 可用池，只读不写）
  2. 对"开着的"条目跑 flash 路由 / 插件条件 → 有效集   —— 第二道筛选
  3. 组装有效集文本 → EjsTemplate.evalTemplate() 求值  —— 复用 ST 的 EJS/宏引擎
  4. setExtensionPrompt() 注入已求值成品              —— 不动 UI 开关
→ 主模型按"原卡 + 仅相关规则"生成
```

最终激活 = （用户开关 ON）∩（符合插件条件）。ST 对这些规则条目不自动注入，注入权归本扩展。

## 状态

`v0.1.0`：
- 魔棒菜单新增「规则路由配置」入口，打开配置弹窗。
- 配置弹窗：flash API（Base URL / Key / 获取模型 / 选模型）；「刷新」抓取使用中的世界书，逐条目可开启「文字过滤」并填启用条件。配置持久化到 `extensionSettings`。
- 运行时：`GENERATION_AFTER_COMMANDS` 调 flash 据情境判断各过滤条目是否满足条件；`WORLDINFO_ENTRIES_LOADED` 把未命中的条目本次扫描置 `disable`（不落盘、不动 UI）。未配置 API 时不路由（全部照常），安全降级。

机制经 SillyTavern 1.16 源码确认（`getSortedEntries` 克隆前 emit `WORLDINFO_ENTRIES_LOADED`，改 `disable` 仅影响本次扫描）。

## 安装

ST → 扩展 → 安装扩展 → 输入本仓库 git 地址；或把本目录放到
`<SillyTavern>/data/<user>/extensions/cultivation-rule-router/` 后刷新页面。

## 依赖

- SillyTavern ≥ 1.16
- [ST-Prompt-Template](https://github.com/) 扩展（提供 `EjsTemplate.evalTemplate`，处理规则文本中的 EJS/宏）

## 开发

扩展即 `manifest.json` + `index.js`，无构建步骤。改完刷新 ST 页面即生效。
