# Registry entries

每个已收录插件占一个文件：

```text
registry/entries/<github-owner>/<plugin-slug>.json
```

文件内的 `plugin.id` 必须与路径组成的 `<github-owner>/<plugin-slug>` 一致。不要把示例、
测试 fixture 或临时预约放进本目录；合并到 `main` 的文件就是公共注册记录。

每个 entry 必须使用 v2 Schema，固定插件仓库中的 `dsh-plugin.naming.json` commit，并补充
Harness 版本范围与运行时上下文。自动发现候选只能放在 `discovery/`，不得复制到这里形成
未经所有权和上下文审核的占用。
