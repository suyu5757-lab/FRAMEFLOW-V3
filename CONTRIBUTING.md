# Contributing to FRAMEFLOW V3

感谢参与 FRAMEFLOW V3。请保持提交可复现、可审查，并避免把本机数据带入仓库。

## 开发流程

1. 从 `main` 创建短生命周期分支。
2. 只提交源码、测试、文档、锁文件和部署配置。
3. 不提交 `.env`、数据库、媒体资产、日志、构建产物、依赖目录或 IDE 文件。
4. 对行为变更补充或更新测试，并在提交前运行后端和前端验证。
5. Pull Request 说明变更目的、测试命令和已知限制。

## 本地验证

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
npm test
Push-Location web
npm test
npx tsc -b --pretty false
npm run build
Pop-Location
```

## 安全要求

- API Key、Token、Cookie、密码和本机登录态只能通过环境变量或系统凭据库提供。
- 示例配置只能保留变量名，不得放入真实值。
- 新增外部服务时，说明其权限、数据流向和失败行为。
- 发现疑似泄露时，立即停止提交并轮换凭据，再通过私密渠道报告。

## 提交信息

使用清晰、简短的 Conventional Commits 风格，例如：

- `feat: add provider capability check`
- `fix: reject non-loopback server binding`
- `test: cover timeline recovery`
- `docs: clarify local setup`
