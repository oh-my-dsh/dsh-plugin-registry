# 中文

## 设计原因

说明为什么需要登记或更新这个插件，以及当前缺少这条记录会造成什么问题。

## 作用与预期效果

- 插件 ID：`owner/plugin`
- 仓库：`https://github.com/owner/repository`
- Entry：`registry/entries/owner/plugin.json`
- 说明登记后能帮助开发者发现哪些已知重叠。

## 所有权与来源

- [ ] GitHub 仓库 owner 与插件 namespace 一致。
- [ ] `source.commit` 是 40 位固定提交，不是分支或 tag。
- [ ] 固定 `dsh-plugin.naming.json` 与 entry 的 coordinate、package 和全部名称一致。

## 上下文与冲突

- [ ] 已填写 Harness 版本范围、scope、Loader 层/覆盖意图、Skill provider/rank、事件 schema 和路由 kind。
- [ ] 已审核工作流报告的每一项冲突。
- [ ] 有意保留的重叠已在下方解释。
- [ ] 未把端口或同名共享事件误写成排他 ID。

## 验证

- [ ] `npm run build:index`
- [ ] `npm test`
- [ ] `npm run validate`
- [ ] `npm run validate:sources`

## 限制与剩余风险

说明未覆盖版本、未知 scope、动态声明、发现盲区或有意重叠。

---

# English

## Design Rationale

Explain why this plugin needs to be registered or updated and what problem the missing record causes.

## Purpose And Expected Effect

- Plugin ID: `owner/plugin`
- Repository: `https://github.com/owner/repository`
- Entry: `registry/entries/owner/plugin.json`
- Explain which known overlaps developers can detect after registration.

## Ownership And Source

- [ ] The GitHub repository owner matches the plugin namespace.
- [ ] `source.commit` is an immutable 40-character commit, not a branch or tag.
- [ ] The pinned `dsh-plugin.naming.json` matches the entry coordinate, package, and every declared name.

## Context And Conflicts

- [ ] Harness range, scope, Loader layer/intent, Skill provider/rank, event schema, and route kind are complete.
- [ ] Every workflow-reported conflict has been reviewed.
- [ ] Intentional overlaps are explained below.
- [ ] Ports and shared event names are not treated as exclusive IDs.

## Verification

- [ ] `npm run build:index`
- [ ] `npm test`
- [ ] `npm run validate`
- [ ] `npm run validate:sources`

## Limits And Residual Risk

Document untested versions, unknown scopes, dynamic declarations, discovery gaps, or intentional overlaps.
