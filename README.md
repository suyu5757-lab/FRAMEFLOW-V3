# FRAMEFLOW V3

FRAMEFLOW V3 是一个本地优先的 AI 视频制作工作台，把脚本、分镜、角色/场景/道具资产、融合、镜头、声音、质量检查和交付编排在一条可追溯的生产流程中。

## 架构

```text
React/Vite Studio  →  FastAPI application  →  FrameFlow domain modules
                                      ↘  SQLite runtime data
                                      ↘  provider adapters / local tools
```

- `server.py`：FastAPI 应用、API 路由和本地运行时生命周期。
- `frameflow/`：数据库、工作流、资产审计、Provider、恢复、媒体和安全边界模块。
- `web/`：React + TypeScript + Vite 前端工作台。
- `tests/`：Python 单元/集成测试；`web/src` 和 `web/tests` 包含前端与浏览器测试。
- `.github/workflows/ci.yml`：Windows CI，执行后端、前端、类型、构建和浏览器验收门禁。

运行时数据库、生成媒体、上传文件、日志、备份和 CLI 登录态只保存在本机资源目录中，这些目录不会提交到 Git。默认资源目录是项目根目录；可以通过 `FRAMEFLOW_RESOURCE_DIR` 将它们统一放到工作台之外的独立磁盘目录。

## 技术栈

- Python 3.13+、FastAPI、Uvicorn、Pydantic、SQLite、Keyring、HTTPX
- Node.js 22+、React 19、TypeScript、Vite、Vitest、Playwright
- 可选本地工具：FFmpeg、OpenCode Server、即梦 CLI、ComfyUI

## 安装

### 后端

```powershell
python -m venv .venv
\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

### 前端

```powershell
Push-Location web
npm ci
npm run build
Pop-Location
```

## 环境变量

复制 `.env.example` 为本地 `.env`，或在启动前设置环境变量。`.env` 永远不要提交。

- `FRAMEFLOW_BIND_HOST`：绑定地址，默认只允许 `127.0.0.1`、`localhost` 或 `::1`。
- `FRAMEFLOW_RESOURCE_DIR`：可选的本地制作资源根目录。配置后，`data/`、`generated/`、项目上传素材、生成媒体、代理文件、交付文件和安全备份都会位于该目录下；工作台代码和 `web/dist` 仍位于项目目录。
- `FRAMEFLOW_DB_PATH`：可选的 SQLite 路径；默认使用运行时数据目录。
- `JIMENG_CLI_HOME`、`JIMENG_CLI_PATH`：即梦 CLI 的本地登录目录和可执行文件配置。
- `FRAMEFLOW_FFMPEG_PATH`、`FRAMEFLOW_FFPROBE_PATH`：可选的 FFmpeg/FFprobe 完整路径；未设置时从系统 PATH 查找。
- `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`COMFYUI_API_KEY`：仅用于从环境变量导入凭据；运行时优先使用系统凭据库。
- `OPENCODE_SERVER_PASSWORD`：OpenCode Server 的可选 Basic Auth 密码。

应用不会把凭据写入项目 JSON、运行快照、前端存储或日志。不要把真实密钥写进源代码、测试夹具或文档。

macOS 示例：

```env
FRAMEFLOW_RESOURCE_DIR="/Users/yusu/Desktop/framflow v3 resource"
```

配置后，资源目录结构大致为：

```text
/Users/yusu/Desktop/framflow v3 resource/
├── data/
│   ├── frameflow.db
│   ├── projects/
│   ├── exports/
│   ├── safety-backups/
│   └── dreamina-home/
└── generated/
    └── audio/
        └── references/
```

代码目录仍然保留在当前项目目录，前端构建目录也仍然是 `web/dist/`。

## 启动

先完成前端构建，再启动本地服务：

```powershell
python server.py
```

服务默认运行于 `http://127.0.0.1:8787/`。Windows 用户也可以运行 `启动工作台.bat`；脚本会以自身所在目录作为项目根目录，不依赖固定机器路径。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

FFmpeg 不参与基础工作台启动，但视频代理、时间线渲染和最终交付需要可用的 `ffmpeg` 与 `ffprobe`。

## 测试与验证

```powershell
# 后端
python -m unittest discover -s tests -p "test_*.py" -v

# 根目录验证入口
npm test

# 前端单元、类型和生产构建
Push-Location web
npm test
npx tsc -b --pretty false
npm run build

# 可选浏览器验收
npx playwright install chromium
npm run test:e2e
Pop-Location
```

完整 CI 还会执行依赖安装、浏览器验收和 JavaScript 语法检查。

## 生产与安全边界

- 默认只绑定回环地址，不提供公网认证层。
- 修改状态的浏览器请求受本机 Origin 边界保护。
- 付费媒体任务需要显式确认；未配置 Provider 时不会伪造媒体结果。
- 所有本机数据、凭据、缓存和构建输出均通过 `.gitignore` 排除。

## 许可证

本项目使用 [MIT License](LICENSE)。贡献规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。
