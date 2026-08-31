# 新电脑与新 Codex 首次接手

## 接手目标

下载仓库后，不依赖历史聊天、不扫描历史成品、不调用付费模型，也能确认项目结构、开发环境和核心流程合同是否健康。这里的“零成本”指首次理解、安装和自动验证不发起真实扩写、识图或生图请求；真正生成商品图仍可能产生上游服务费用。

## 给新 Codex 的第一句话

```text
请先严格按根目录 AGENTS.md 路由接手项目。读取 docs/handoff/README.md、CURRENT_STATUS.md 和 FIRST_RUN.md；不要扫描历史目录，不要输出任何密钥，不要运行真实生图。先执行无付费初始化和 verify:quick，报告当前状态后再处理我的具体需求。
```

## 固定读取顺序

1. `AGENTS.md`：唯一强制路由、安全和付费操作边界。
2. `docs/handoff/README.md`：专题选择方法。
3. `docs/handoff/CURRENT_STATUS.md`：现在真实能力、风险和下一步。
4. 本文件：首次克隆初始化与无付费验收。
5. 只再选择一个相关专题，然后定位源码；禁止为了“了解项目”扫描全部 Markdown、`已完成/` 或整个源码树。

## Windows 首次初始化

要求 Git、Node.js 24+。首次下载：

```powershell
git clone https://github.com/hrbj18/BGE-ecommerce-auto-image-gen.git
Set-Location BGE-ecommerce-auto-image-gen
```

在仓库根目录运行：

```powershell
node --version
corepack enable
pnpm install --frozen-lockfile
pnpm run bootstrap
```

也可以直接双击根目录 `一键启动项目.bat`。启动器会验证 Node.js 24+，在缺少 pnpm 时通过 Corepack 自动启用，并在首次下载后缺少 `node_modules` 时按锁文件自动安装依赖；完成后启动前后端。若网络或权限导致自动准备失败，窗口会保留中文原因、退出代码和日志路径，再按上面的手动命令排障。

`bootstrap` 只创建缺失的 `待作图/`、`已完成/`、`data/`、`output/`、`templates/` 和本机 `.env`。已有目录、需求模板和 `.env` 一律保留；命令不会调用任何模型或生图 API。

## 无付费验收

快速接手检查：

```powershell
pnpm run verify:quick
```

它执行类型检查、关键流程单测、前端构建、handoff 审计和发布集合审计，不读取真实密钥、不连接模型、不生成商品图。预计用于首次接手和普通文档/小改动验收。

提交重大功能前执行完整离线回归：

```powershell
pnpm run verify:free
```

完整测试会覆盖 5+8 提示词、并发、重试、缺图恢复、审核与 Web 合同。测试中的供应商响应是本地桩，不产生第三方调用费用；运行时间明显长于快速检查。

## 配置与真实运行边界

- `.env.example` 可提交，`.env` 只保存在本机且被 Git 忽略。
- `pnpm run bootstrap` 只复制空配置，绝不覆盖已存在的 `.env`。
- 不从 README、历史聊天、旧任务或 Git 恢复任何 key。
- 没有明确授权时，只能运行上述离线验证，不能用真实 SKU 做扩写、识图、生图或返工。
- 真实运行前先读 `MODEL_PROVIDERS.md`，只报告密钥“已配置/未配置”，不要打印值。
- 第一次验证真实供应商时遵循“健康检查 → 一张低成本图 → 完整 5+8”，禁止直接批量消耗额度。

## 首次接手验收标准

- `git status --short` 没有来源不明的改动。
- `node --version` 主版本不低于 24，依赖可用锁文件安装。
- `pnpm run bootstrap` 明确报告创建和保留项，且不覆盖本机配置。
- `pnpm run verify:quick` 全部通过。
- `.env`、客户输入、历史成品、日志、缓存和 `node_modules` 不在 Git 跟踪列表。
- 新 Codex 能根据 `CODE_MAP.md` 定位命令，根据专题文档定位相关源码，无需历史聊天。

若检查失败，只修复当前失败层；先记录命令、退出码和错误分类，再读对应专题。不要通过运行真实生图来证明普通代码或文档修改有效。
