# 中文

## 支持范围

安全修复面向 `main` 上当前的正式注册契约、冲突检测脚本、GitHub Action、发现工作流和审核
规则。自动发现候选是公开不可信输入，不应被任何客户端当作可执行代码或正式占用。

## 报告方式

请优先使用 GitHub 仓库的私有 Security Advisory 报告注册表投毒、身份冒用绕过、固定来源
校验绕过、工作流权限提升、令牌泄漏或可导致客户端执行不可信内容的问题。不要在公开 Issue
中粘贴凭据、未公开利用代码或个人数据。

普通误报、漏报和冲突语义建议可以使用公开 Issue，并附最小 JSON 夹具、Harness 版本和预期
scope。注册表不接收私有插件源码；复现材料应删去密钥和专有数据。

---

# English

## Supported Surface

Security fixes cover the current formal registry contract on `main`, conflict-checking scripts, GitHub
Action, discovery workflow, and review controls. Automated discovery candidates are public untrusted
input and must never be treated as executable code or formal reservations.

## Reporting

Prefer a private GitHub Security Advisory for registry poisoning, identity-proof bypasses, pinned-source
verification bypasses, workflow privilege escalation, token exposure, or any path that could make a
client execute untrusted content. Do not post credentials, unpublished exploit details, or personal data
in a public Issue.

Ordinary false positives, missed conflicts, and semantic proposals may use a public Issue with a minimal
JSON fixture, Harness version, and expected scope. The registry does not accept private plugin source;
remove secrets and proprietary data from all reproduction material.
