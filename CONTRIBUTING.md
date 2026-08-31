# Contributing

本仓库只接受正式注册表、候选发现、冲突检测规则、Schema、CLI、Action 和治理文档相关改动。
Agent Skill、插件实现、本地命名风格和部署端口检查应在各自仓库维护。

## 正式登记

1. 基于最新 `main` 创建分支。
2. 在插件仓库提交通过校验的 `dsh-plugin.naming.json`。
3. 复制 `registry/examples/plugin-registration.example.json`。
4. 使用插件仓库的 40 位 commit 固定 `source`，补充 Harness 范围和每项运行时上下文。
5. 保存到 `registry/entries/<github-owner>/<plugin-slug>.json`。
6. 重新生成索引并运行全部验证。
7. 使用登记模板提交中文在前、英文在后的完整 PR 说明。

```sh
npm run build:index
npm test
npm run validate
npm run validate:sources
```

路径、`plugin.id`、仓库 GitHub owner、固定命名清单的 coordinate 和 package 必须一致。
`pluginNames` 与同名 event 不是排他占用；端口不得登记。普通上下文冲突是审核信息，身份冒用、
无效清单、来源不一致、错误路径和过期索引不能合并。

## 候选转正式登记

`discovery/candidates.json` 中的记录只用于调查。晋级前必须确认固定 commit 上存在真实 DSH
插件证据、补齐本地命名清单、获得可审查的上下文，并单独提交正式登记 PR。不得根据 topic、
文本、star 或候选 coordinate 自动生成正式 ID 占用。

## 修改检测或发现逻辑

保持工具无运行时依赖，不下载或执行候选插件代码。新增正式冲突种类时同步修改 Schema、示例、
输出文档和回归测试；说明默认模式、严格模式和旧客户端兼容性。新增发现信号时必须保存固定来源
证据、标记置信等级，并证明它不会写入正式索引。

PR 必须说明设计原因、实际作用、预期效果、限制和验证。中文完整结束后再写完整英文，不逐句混排。
