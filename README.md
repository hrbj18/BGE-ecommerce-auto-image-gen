# BGE Ecommerce Auto Image Gen

本地运行的电商套图工作台。用户上传商品参考图和原始需求后，系统会完成视觉识别、需求扩写、结构化分镜、逐图提示词、生成、审核、缺图恢复与打包。标准任务输出 5 张主图和 8 张详情页图片。

仓库默认按私有项目维护，不包含 API 密钥、客户素材、历史成品、运行日志或本机缓存。

## 当前能力

- Web 工作台：提交任务、查看首图和实时进度、浏览历史结果。
- 双供应商接口：aiEcho 与 OpenAI-compatible；供应商和模型由本机 `.env` 决定。
- 逐图创意导演：每张图具有独立画面任务、文案合同、构图和禁用项。
- 速度与恢复：主图优先、稳定并发、限流降级、缺图并行补齐、后台视觉质检和定向返工。
- 可追踪产物：保留扩写结果、分镜、提示词、质量报告和任务进度。
- 固定输出规格：5 张 1:1 主图、8 张 9:16 详情图以及打包结果。

真实生图的速度、费用、文字正确率和视觉质量取决于所配置的上游服务。自动化测试不会发起付费生图，也不能替代真实 SKU 验收。

## 环境要求

- Windows 10/11
- Node.js 24 或更高版本
- Corepack / pnpm
- 可用的 aiEcho 激活码或 OpenAI-compatible API 凭据

## 本地启动

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run bootstrap
```

`bootstrap` 会创建缺失的运行目录和空白 `.env`，但绝不覆盖已有配置，也不会调用任何模型。先执行无付费快速验收：

```powershell
pnpm run verify:quick
```

新电脑或新 Codex 的完整接手说明见 `docs/handoff/FIRST_RUN.md`。需要真实生图时，再在本机 `.env` 中填入自己拥有的凭据并运行：

```powershell
pnpm run web
```

也可以双击 `一键启动项目.bat`。默认前端地址为 `http://127.0.0.1:5173`，后端健康检查为 `http://127.0.0.1:8787/health`。

## 配置原则

`.env.example` 只提供无密钥示例。实际 `.env` 永远只保留在本机：

- `IMAGE_PROVIDER=aiecho`：使用 aiEcho 生图接口。
- `IMAGE_PROVIDER=openai`：使用 OpenAI-compatible 生图接口。
- `OPENAI_TEXT_MODEL`：需求扩写模型。
- `OPENAI_VISION_MODEL`：商品识图与输出视觉审核模型。
- `OPENAI_IMAGE_MODEL`：生图模型。
- `OPENAI_IMAGE_CONCURRENCY` 与并发阶梯：控制首发吞吐和限流降级。

模型名称必须与所接入服务实际支持的 ID 完全一致。项目不会从历史文档恢复密钥，也不会自动把真实密钥写入仓库。

## 使用方式

### Web 工作台

运行 `pnpm run web`，在页面中上传商品图、填写原始用户需求并创建任务。任务生成期间可先查看已经落盘的主图；后台继续生成详情页、补图、质检和打包。

### 文件夹模式

将商品图片放入 `待作图/`，按 `待作图/需求模板.md` 填写需求，然后运行：

```powershell
pnpm run folder
```

运行产物写入 `已完成/`。这些目录默认被 Git 忽略，只有脱敏需求模板和抽象案例学习库进入仓库。

## 开发验证

```powershell
pnpm run typecheck
pnpm test
pnpm run frontend:build
pnpm run handoff:audit
pnpm run release:audit
pnpm run verify:quick
pnpm run verify:free
```

`release:audit` 会检查拟提交文件，阻止密钥、客户输入、历史成品、缓存和超大文件进入版本库。GitHub Actions 会在 Windows 环境执行类型检查、全量测试、前端构建和两类审计。

## 目录导航

- `src/`：任务解析、分镜、创意导演、生图调度与质量审核。
- `scripts/`：Web 后端、启动编排、规则加载与发布审计。
- `frontend/`：React/Vite 工作台。
- `生图规则/`：运行时平台、语言和电商生成规则。
- `tests/`：流程合同、扩写、审核、恢复与并发测试。
- `docs/handoff/`：当前状态、产品约束、架构决策和代码地图。
- `已完成/参考案例分析/zcool-case-library.json`：只含抽象设计规律的案例学习库。

参与开发前请先阅读 `AGENTS.md` 和 `docs/handoff/README.md`；当前事实以 `docs/handoff/CURRENT_STATUS.md` 与运行时代码为准。

## 数据与安全

- 不要提交 `.env`，只维护 `.env.example`。
- 不要提交 `待作图/` 中的客户图片或 `已完成/` 中的生成结果。
- 不要把 Cookie、浏览器登录态、API key 或第三方激活码写入文档、Issue 或日志。
- 未经明确授权，不应通过测试发起付费生图或整套返工。

本仓库暂未附加开源许可证；除非仓库所有者另行授权，不授予公开复制、再分发或商用许可。
