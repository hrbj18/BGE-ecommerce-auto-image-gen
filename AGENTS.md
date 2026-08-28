# Codex Project Router

本文件是项目唯一的强制上下文入口。先按路由读取，不要扫描全部 Markdown、历史任务、`已完成/`、`待作图/`、`AI电商生图提示词/` 或整个源码树。

## 默认读取

处理项目开发、排障或交接任务时，先读：

1. `docs/handoff/README.md`
2. `docs/handoff/CURRENT_STATUS.md`

随后只读取与当前任务匹配的一个专题文件，再检查相关源码：

- 生图质量、提示词、分镜、返工：`docs/handoff/GENERATION_PIPELINE.md`
- 前端、后端、历史任务、局域网、一键启动：`docs/handoff/WEB_APP.md`
- 模型、API、中转站、密钥、并发、超时：`docs/handoff/MODEL_PROVIDERS.md`
- 稳定产品约束：`docs/handoff/PRODUCT_RULES.md`
- 架构理由或既定选择：`docs/handoff/DECISIONS.md`
- 文件和命令入口：`docs/handoff/CODE_MAP.md`

普通问答只读需要的文件；不要为了“了解项目”加载全部专题。

## 权威性

- 当前事实和下一步：`CURRENT_STATUS.md`
- 稳定产品行为：`PRODUCT_RULES.md`
- 当前有效决策：`DECISIONS.md`
- 运行时代码与测试高于历史文档。
- `00-先看这里-Codex接手说明.md`、`给Codex看的运行说明.md`、旧优化指导文档属于历史资料，除非当前 handoff 文件明确引用，否则不得当成现行规则。
- 生图运行规则以 `生图规则/` 和加载器为准；密钥与服务地址以本机运行配置为准，禁止从历史聊天或文档恢复旧值。

## 安全与操作边界

- 不输出、提交、写入文档或测试任何 API key、密码、Cookie 或登录态。
- 不删除 `待作图/`、`已完成/`、用户素材或历史任务，除非用户明确要求；删除任务必须走项目已有的成对清理逻辑。
- 不因排障发起付费生图；需要真实生成或批量返工时先确认这是用户当前要求。
- 不覆盖用户已有改动，不使用破坏性 Git/文件命令。
- 修改供应商、模型、并发或超时前先读取 `MODEL_PROVIDERS.md`，并保留可回滚配置。

## 更新规则

只在实现、状态、决策、阻塞或下一步发生实质变化时更新 handoff。替换过时结论，不追加聊天流水账。稳定规则、当前状态和专题实现必须分开维护。

完成重大改动后运行：

```powershell
npm run handoff:audit
```
