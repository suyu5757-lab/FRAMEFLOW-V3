# FRAMEFLOW V3 项目清理审计

审计日期：2026-08-25
审计方式：只读检查，审计阶段未删除或覆盖项目文件。

## 1. 当前仓库概况

- 当前分支：`main`
- 当前 HEAD：`7e3e0a9`（已有 Git 历史）
- 当前 `origin`：指向旧远程仓库，尚未切换到目标仓库。
- 工作区总大小（含 `.git`）：约 279.17 MB，6779 个文件。
- 项目文件大小（不含 `.git`）：约 130.21 MB。
- Git 对象库：约 127.26 MiB；发现 3 个 Git 临时垃圾对象，共约 21.66 MiB。当前审计未修改 `.git`。
- 已追踪文件：11 个，约 0.77 MB。
- 工作区状态：4 个已修改、5 个已删除、46 个未追踪项目，共 55 项状态变化。

## 2. 文件分类

### 必须保留

- 后端源码：`server.py`、`frameflow/`
- 前端源码：`web/src/`、`web/index.html`
- 测试源码：`tests/*.py`、`web/src/*.test.*`、`web/tests/`
- 依赖与构建配置：`requirements.txt`、`package.json`、`web/package.json`、`web/package-lock.json`、TypeScript/Vite/Playwright 配置
- 工程脚本：`scripts/verify.mjs`、`web/scripts/`
- CI：`.github/workflows/ci.yml`
- 产品文档：后续整理后的 `README.md`、`CONTRIBUTING.md`、`LICENSE`、示例环境变量文件
- 当前工作区已有的 V3 迁移：旧版 `app.js`、`audio.js`、`index.html`、`styles.css` 及旧测试文件已处于删除状态；这属于当前工作区变更，不能在清理时误恢复。

### 可删除的本机缓存、构建产物与测试生成文件

以下内容不是生产源码，也不应上传：

- `web/node_modules/`：4299 个文件，约 91.00 MB
- `.venv/`：2245 个文件，约 34.72 MB
- `__pycache__/` 与 `frameflow/__pycache__/`：26 个文件，约 1.21 MB
- `data/`：67 个本地数据库、CLI 登录态、日志和媒体资产，约 120.06 MB
- `backups/`：13 个本地数据库、日志和清单，约 24.46 MB
- `tests/*.db`、`*.db-wal`、`*.db-shm`：测试生成数据库；当前发现 29 个 SQLite 类文件，未发现 wal/shm 文件
- `web/dist/`：构建产物，约 0.84 MB
- `web/playwright-report/`、`web/test-results/`：浏览器测试输出
- `web/artifacts/`：测试截图
- `web/tsconfig.app.tsbuildinfo`：TypeScript 构建缓存
- `.codex-remote-attachments/`：远程附件缓存
- `.skill-staging/`：技能暂存文件
- `data/dreamina-home/`：本机 CLI 登录态、日志和 PowerShell 配置

### 风险文件

- `启动工作台.bat` 含当前机器绝对路径，应改为基于脚本目录的相对路径或环境变量。
- `frameflow/media.py` 含当前机器的 FFmpeg/FFprobe 绝对路径，应改为环境变量加系统 PATH 探测。
- 多份根目录内部计划/执行报告含本机路径、工作区路径或内部工具路径，不适合作为公开生产仓库文件；应删除或改为不含机器信息的公开文档。
- `data/`、`backups/`、测试数据库和媒体资产可能包含用户项目、生成媒体、登录态、凭据引用或其他本机数据，禁止上传。
- `web/dist/`、`web/playwright-report/` 和 `web/test-results/` 可能包含构建时间、测试路径和用户工作区信息，不应上传。

## 3. 敏感信息扫描结果

- 在当前非缓存源码、配置和文档中，未发现常见第三方密钥格式、私钥块或 Bearer 长令牌格式的疑似真实密钥值。
- 在当前 `HEAD` 已追踪内容中，同样未发现上述疑似真实密钥值。
- 扫描命中 `API_KEY`、`TOKEN`、`PASSWORD`、`SECRET`、`COOKIE` 等词语，均为变量名、字段名、脱敏逻辑、测试断言或安全说明；不能将这些词名本身视为密钥。
- 当前没有发现 `.env` 或 `.env.*` 文件；后续只提交不含值的 `.env.example`。
- 发现的本机路径和本机数据风险仍必须在上传前处理，即使没有发现密钥值。

## 4. 建议的清理顺序

1. 先由用户手动删除上方列出的缓存、数据库、备份、附件和暂存目录中的文件；不要删除 `server.py`、`frameflow/`、`web/src/` 或测试源码。
2. 将启动脚本和 FFmpeg 探测改为跨机器实现，移除本机绝对路径。
3. 删除或移出含本机路径的内部计划/执行报告，只保留公开项目文档。
4. 更新 `.gitignore`，覆盖 Python、Node、SQLite、AI 缓存、IDE、Windows 和测试输出。
5. 生成 `.env.example`、`CONTRIBUTING.md` 和 MIT `LICENSE`，重写生产级 `README.md`。
6. 重新扫描工作树与 Git 暂存区，确认没有本机数据、凭据值、绝对用户路径或构建产物后再提交和推送。

## 5. 结论

当前源码具备整理为生产仓库的基础，但工作区尚未达到可公开发布状态。最大问题不是发现了真实密钥，而是本机数据/缓存体积较大、旧远程仓库仍在使用、以及若干脚本和内部报告泄露了机器路径。必须完成清理和安全复核后，才可切换到 `FRAMEFLOW-V3` 远程仓库并创建 `v3.0.0` Release。
