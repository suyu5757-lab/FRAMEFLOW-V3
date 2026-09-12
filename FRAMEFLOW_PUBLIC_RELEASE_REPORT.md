# FRAMEFLOW V3 Public Release Report

状态：`READY_FOR_CONFIRMATION`
生成日期：2026-08-25
发布目标：[suyu5757-lab/FRAMEFLOW-V3](https://github.com/suyu5757-lab/FRAMEFLOW-V3)

## 1. 发布副本

- 发布副本由当前开发项目复制而来。
- 旧 `.git` 目录和旧远程配置未复制；发布副本当前尚未初始化 Git。
- 原开发目录在本次公开发布副本流程中未修改。
- 复制阶段保留源码、测试、配置、CI 和公开文档；本机数据与内部开发记录未进入发布副本。

## 2. 排除/清理文件列表

以下内容在复制阶段排除，未进入公开发布副本：

- `.git/`
- `.venv/`
- `web/node_modules/`
- `data/`
- `backups/`
- `generated/`
- `__pycache__/`、`frameflow/__pycache__/`
- `web/dist/`
- `web/playwright-report/`
- `web/test-results/`
- `web/artifacts/`
- `.codex-remote-attachments/`
- `.skill-staging/`
- `*.db`、`*.sqlite*`、`*.db-wal`、`*.db-shm`、`*.log`、`*.pyc`、`*.tsbuildinfo`
- 内部计划、修复记录、测试异常报告、维护记录和带本机路径的内部文档
- 本机 Voice Controller 截图资产

验证过程中产生的 `node_modules`、前端 `dist`、Python 缓存、Playwright 输出和测试临时文件均位于被 `.gitignore` 覆盖的路径，不会进入 Git 发布内容。

## 3. 新增与修改文件列表

- 新增：`.env.example`
- 新增：`LICENSE`（MIT）
- 新增：`CONTRIBUTING.md`
- 新增：`FRAMEFLOW_PUBLIC_RELEASE_REPORT.md`
- 保留：`PROJECT_CLEANUP_AUDIT.md`
- 更新：`.gitignore`
- 更新：`README.md`
- 更新：`启动工作台.bat`，改为使用脚本所在目录，不再包含固定机器路径
- 更新：`frameflow/media.py`，改为使用 `FRAMEFLOW_FFMPEG_PATH`、`FRAMEFLOW_FFPROBE_PATH` 或系统 PATH

## 4. 安全扫描

- 常见第三方密钥格式：未发现
- 私钥块：未发现
- 长 Bearer Token：未发现
- `.env` / `.env.*` 实际配置文件：未发现；仅保留空值 `.env.example`
- 本机绝对路径：源码、公开文档和脚本中未发现
- 凭据词汇命中：仅存在于变量名、字段名、脱敏逻辑、测试断言和安全说明中，无真实值
- 公开发布 Git 暂存区扫描：待用户确认后执行 Git 初始化并再次扫描

## 5. 工程验证

| 检查项 | 结果 |
| --- | --- |
| Python 依赖导入 | 通过 |
| 后端测试 | 128/128 通过 |
| 前端 Vitest | 33/33 通过 |
| 前端 TypeScript 检查 | 通过 |
| 前端生产构建 | 通过 |
| Bundle gate | 通过 |
| Playwright 浏览器验收 | 9/9 通过 |
| FastAPI 启动 | 通过 |
| `/api/health` | `ok=true`，无 Provider 时为预期 `degraded` |

健康检查的 `degraded` 状态仅表示公开副本未配置本机 Provider、FFmpeg 或 CLI 登录态；服务启动、数据库迁移和健康端点均正常。

## 6. Git 与 Release 状态

- Git 初始化：等待确认
- Commit：等待确认
- Commit hash：`PENDING_CONFIRMATION`
- Remote：等待确认后添加目标仓库
- Push：等待确认
- Release：等待确认，目标版本 `v3.0.0`
- Release 标题：`FRAMEFLOW V3 Initial Production Release`

## 7. 后续操作

收到明确确认后，按以下顺序执行：

1. 在发布副本初始化 Git 并确认没有继承旧 remote。
2. `git add .` 后检查 `git ls-files`，确保没有数据库、缓存、用户数据、密钥或本机路径。
3. 创建提交：`chore: prepare FRAMEFLOW V3 production repository`。
4. 设置 `main`、添加目标 remote 并推送。
5. 创建 `v3.0.0` GitHub Release，说明为 `FRAMEFLOW V3 Initial Production Release`。

本报告在确认前不执行 commit、push 或 Release 创建。
