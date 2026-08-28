# 代码地图

## 启动与命令

- 一键启动：`一键启动项目.bat`
- Web 编排：`scripts/dev-web-app.mjs`
- 本地后端：`scripts/local-web-server.mjs`
- 生成进度解析：`scripts/generation-progress.mjs`
- 前端：`frontend/src/App.jsx`、`frontend/src/styles.css`
- 文件夹工作流：`npm run folder`
- Web：`npm run web`
- 类型检查：`npm run typecheck`
- 全量测试：`npm test`
- 上下文审计：`npm run handoff:audit`
- GitHub 发布集合审计：`npm run release:audit`
- 便携 pnpm 命令解析：`scripts/runtime-commands.mjs`
- GitHub CI：`.github/workflows/ci.yml`
- 现有成品视觉审计：`npm run audit:output -- --dir <成品目录>`；经明确授权的定向返工追加 `--retry-failed`

## 生图链路

- 配置读取：`src/config.ts`
- 输入任务解析：`src/folder-task-source.ts`
- 本地执行器：`src/local-worker.ts`
- 基础分镜：`src/storyboard-planner.ts`
- 逐图创意与紧凑提示词：`src/creative-director.ts`
- 供应商请求、调度、重试、补图、审核编排：`src/openai-image-generator.ts`
- 提示词审核：`src/prompt-audit.ts`
- 输出审核：`src/output-audit.ts`
- 已有成品审计/定向返工入口：`src/audit-output.ts`
- 规则加载：`scripts/generation-rule-loader.mjs`
- AI 扩写规则：`scripts/brief-expansion-rules.mjs`

## 规则与状态

- 公共和平台/语言规则：`生图规则/`
- 运行时任务记录：`data/`
- 输入：`待作图/`
- 输出：`已完成/`
- 日志与调试证据：`logs/`、各任务输出目录中的 JSON 文件

## API 入口

`scripts/local-web-server.mjs` 提供任务、扩写、输出和静态成品接口。先用 `rg -n "api/jobs|api/brief-expansions|api/outputs" scripts/local-web-server.mjs` 定位，不要整文件通读。

## 测试路由

- 创意/分镜：`tests/creative-director.test.ts`、`tests/storyboard-planner.test.ts`
- 生图兼容与恢复：`tests/openai-image-generator-native.test.ts`
- 调度优先级、受限并行与进度协议：`tests/generation-speed.test.ts`
- 扩写与污染防护：`tests/brief-expansion-rules.test.ts`、`tests/prompt-cache.test.ts`
- 审核：`tests/prompt-audit.test.ts`、`tests/output-audit.test.ts`
- Web 后端逻辑主要位于大体量脚本，改动时补最邻近的可测试模块，并至少做端点冒烟测试。
