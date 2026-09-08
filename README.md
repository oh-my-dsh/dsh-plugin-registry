# DSH 插件冲突注册表

本仓库是 DSH 社区插件的公共协调层。它保存经过审核的插件身份、固定来源证据、Harness
兼容范围和带上下文的公开名称声明，帮助开发者在发布前发现已知冲突。注册表不下载、不
安装，也不执行第三方插件代码。

当前仓库由 `oh-my-dsh` 作为社区临时协调点维护，后续可随 DSH 社区治理成熟度迁移到新的
长期归属。客户端必须允许覆盖注册表 URL，迁移时也必须保留清晰的来源和契约版本信息。

本仓库不是 Agent Skill。Skill、插件开发工具和第三方 CI 都只是客户端；正式登记、候选
发现、Schema、冲突语义和审核历史由本仓库独立维护。

注册表只能反映已经合并到 `main` 的公开登记，不是全网唯一性证明。未登记插件、动态名称、
陈旧登记和未声明运行时上下文都会形成盲区。客户端查询失败时必须报告“未知/未检查”，不能
把网络失败解释为“名称可用”。

## 两类数据

| 数据 | 路径 | 是否预留 ID | 是否参与冲突判定 |
|---|---|---:|---:|
| 正式登记 | `registry/entries/`、`registry/index.json` | 是 | 是 |
| 自动发现候选 | `discovery/candidates.json` | 否 | 否 |

自动发现候选只是审核队列。GitHub topic、文本、star 或 code-search 命中都不能自动成为正式
登记；只有包含固定来源证明、完整上下文并通过人工批准的 PR 才能进入正式索引。

## 查询正式索引

机器可读静态索引：

```text
https://raw.githubusercontent.com/oh-my-dsh/dsh-plugin-registry/main/registry/index.json
```

索引当前契约为 `dsh-plugin-registry/v2`。客户端必须同时检查 `schemaVersion` 和 `contract`，
设置超时与响应大小上限，并允许用户覆盖 URL。Raw GitHub 可能存在短时缓存，因此查询结果
必须显示来源和状态，不能声称提供实时全局锁。

生成的索引通过 `$schema` 声明
`registry/schema/plugin-index.schema.json` 的官方 Raw URL。为兼容早期 v2 快照，客户端可接受
缺少 `$schema` 的索引；字段存在时必须精确匹配官方 URL。索引及每个 entry 的未知字段、非法
状态、来源、包名、SemVer、声明结构、重复 `plugin.id` 或 `manifestPath` 都必须导致“未知/未检查”，
不能降格为无冲突。本仓库 CLI 对本地和远程索引统一执行 5 MiB 上限。

克隆仓库后可以精确查询：

```sh
node scripts/plugin-registry.mjs search --kind id --name alice/web-search --index registry/index.json
node scripts/plugin-registry.mjs search --kind service --name aliceWebSearchIndex --index registry/index.json
node scripts/plugin-registry.mjs search --kind route --name "exact /api/plugins/alice-web-search/query" --index registry/index.json
```

`--kind` 支持 `id`、`package`、`pluginName`、`loader`、`service`、`tool`、`command`、
`skill`、`skillProvider`、`event`、`settings` 和 `route`，也接受索引中的复数名。查询使用
大小写敏感的精确匹配。

检查一个完整的中央登记清单：

```sh
node scripts/plugin-registry.mjs check \
  --manifest dsh-plugin.registry.json \
  --registry-url https://raw.githubusercontent.com/oh-my-dsh/dsh-plugin-registry/main/registry/index.json
```

默认模式下，上下文冲突输出告警但返回成功；`--strict` 仅在 `warning` 时返回 `2`。
身份被不同仓库占用或清单无效返回 `1`；`notice` 只说明显式覆盖、确定性优先级或历史状态，
永不阻断。网络或索引错误由 CLI 明确失败，调用方不得把失败降格成“无冲突”。

## GitHub Action

插件仓库可使用复合 Action 检查完整的中央登记清单：

```yaml
name: dsh-plugin-conflicts

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oh-my-dsh/dsh-plugin-registry/.github/actions/check-plugin-conflicts@main
        with:
          manifest: dsh-plugin.registry.json
          strict: 'false'
```

Action 的普通模式在中央索引暂时不可访问时输出明确告警并保持工作流为绿色；严格模式会失败。
生产项目应把 Action 代码固定到版本 tag 或 commit SHA，并通过 `registry-ref` 保持数据索引持续
更新，或显式固定数据快照。Action 代码版本和注册数据版本是两个独立选择。

## 登记插件

1. 先在插件仓库根目录提交通过本地校验的 `dsh-plugin.naming.json`。
2. 对照 `registry/examples/plugin-naming.example.json` 与 `plugin-registration.example.json`，填写真实公开元数据与上下文。
3. 把来源 `commit` 固定到插件仓库的 40 位提交 SHA；不得使用分支或 tag。
4. 保存为 `registry/entries/<github-owner>/<plugin-slug>.json`，路径必须等于 `plugin.id`。
5. 重新生成索引并运行测试、正式校验和来源校验。
6. 使用登记 PR 模板说明设计原因、作用、预期效果、有意重叠和剩余风险。

```sh
npm run build:index
npm test
npm run validate
npm run validate:sources
```

`plugin.repository` 的 GitHub owner、`plugin.id` 的 namespace 和 entry 路径必须一致。固定
`source.namingManifest` 必须逐项证明 coordinate、package 和所有名称声明；上下文信息则由
中央 entry 补充并由维护者审核。PR 创建不等于预留成功，只有合并到 `main` 后才成为正式记录。

## v2 上下文

| 类型 | 必要上下文 | 判定 |
|---|---|---|
| Plugin ID | 仓库身份 | 同一 ID 指向不同仓库时阻断 |
| npm package | 仓库身份 | 不同仓库声明同一包时告警 |
| Plugin module name | 无 | 仅索引，不作为全局排他项 |
| Loader ID | composition、layer、override intent | 显式后层替换为提示；其余重叠为告警 |
| Service、Tool、Command、Provider、Settings | scope | 名称与 scope 重叠且 Harness 范围相交时告警 |
| Skill | scope、provider、rank | rank 不同时提示；同 rank 重叠时告警 |
| Event | scope、publisher/consumer、schema | 同名是共享通道；仅不兼容的多发布者 schema 告警 |
| Web route | kind、path、scope | `kind + path + scope` 重叠且版本相交时告警 |

每项正式登记都必须声明 `compatibility.harness.min`，可选 `maxExclusive`。版本比较遵循 SemVer，
包括 prerelease 顺序；两个范围不相交时不报告运行时声明冲突。

端口不属于静态名称预留。端口是否冲突取决于同机部署、绑定地址、协议和配置覆盖，应由
Profile/部署组合阶段检查，本中央索引不收录端口占用。

## 主动发现

手工执行 10%、20% 或 100% 抽样：

```sh
node scripts/discover-plugins.mjs --coverage 10 --max-results 200
```

爬虫组合以下只读证据：

- 配对的 `dsh` / `deepseek-harness` 与 `dsh-plugin` topics；
- GitHub code search 找到的 `package.json#dsh.bundle`；
- 固定当前 commit 上的根目录或嵌套 `package.json`；
- 同目录可用的 `dsh-plugin.naming.json`。

候选按证据等级优先，再在等级内按 star 排序。`--coverage` 是对 `--max-results` 截断后的
证据样本取分位，并不是全 GitHub 的真实百分位。每周定时工作流默认检查 10%，也可手工选择
20% 或 100%；它只更新候选 PR，不能直接写入正式登记。

`dsh.bundle` 只能证明候选包身份，bundle 的 patch 路径本身不能证明 Loader、service、tool、
command、Skill、event、settings 或 route ID。爬虫仅在同目录存在有效的
`dsh-plugin.naming.json` 时收录这些运行时名称，不从仓库名、说明文字或 patch 注释猜测正式声明。

## 审批与并发

`main` 应启用严格分支保护：必需 `validate` 状态、至少一名批准、合并前更新、对话解决、
线性历史、管理员同样受保护，并禁止 force push 和删除。`CODEOWNERS` 标出正式数据、Schema、
脚本和工作流的维护边界；仓库维护者需要确保列出的 owner 具备相应访问权限。

索引由 entry 确定性生成。CI 会拒绝过期或手工构造的不一致 `registry/index.json`，并验证所有
固定来源。两个基于旧索引的 PR 不能同时绕过最新 base 合并；后合并者必须更新并重新运行检查。
工作流只读取登记 JSON 和公开来源 JSON，不 checkout 或执行插件仓库代码。
