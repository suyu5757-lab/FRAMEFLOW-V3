# FRAMEFLOW V3 创作助手 Agent 工作台逐项验收记录

日期：2026-09-09
测试范围：桌面端创作助手 Agent 工作台 V2、附件管线、统一规范、运行事件、外发确认、跨工作区候选应用，以及现有工作台回归。
验收基准：1440×900 桌面视口；不增加移动端布局、路由或交互。
数据策略：后端专项使用临时 SQLite 和临时 runtime resource 目录；桌面 E2E 使用临时测试数据库；没有把测试运行数据写入项目仓库或用户资源目录。

## 结论

方案范围内的创作助手功能和现有工作台回归均通过。测试结果为：

- Python 全量：207 tests，全部通过。
- 前端 Vitest：52 tests，全部通过。
- 前端 TypeScript、Vite build 和 bundle gate：通过；最新构建最大 JavaScript chunk 417.51 KB raw。
- Playwright 桌面 E2E：17 tests，全部通过，其中 7 条为创作助手专用验收，10 条为现有工作台回归。
- 助手后端专项：34 条独立用例，全部通过。
- 当前 `127.0.0.1:8787` 只读检查：schema 18、`assistant_workspace_v2=true`、资源目录和数据库路径正确；最终服务状态为 `ready`，OpenCode 编排和 MiniMax TTS 已就绪，vision/图片/视频等能力仍按 Provider 状态独立显示未就绪。

## 逐项功能结果

| 编号 | 功能 | 验证内容 | 结果 |
| --- | --- | --- | --- |
| A01 | 统一规范接口 | `/api/v2/contracts`、prompt/story/audio/workflow scope、`/api/v2/workflows`、bundle hash 和版本 | PASS |
| A02 | 规范过期保护 | 运行保存 contract snapshot；规范 hash 改变后旧运行/计划标记 `stale_contract`，返回 409，禁止应用；桌面 UI 锁定旧计划 | PASS |
| A03 | 动态系统指令 | Provider 请求包含当前 bundle hash、字段顺序、Skill 和“永不执行”边界；不含本地路径/凭据 | PASS |
| A04 | 旧接口兼容边界 | 旧 `/api/assistant/stream` 返回 410；旧 Agent plan 通道仍可读，V2 为新增通道 | PASS |
| A05 | 项目级会话隔离 | 会话列表按项目隔离；跨项目会话上传和发送被拒绝；归档会话不能发送 | PASS |
| A06 | 会话归档/恢复 | 归档只改变状态；消息、附件和运行记录保留；恢复后可继续使用 | PASS |
| A07 | 附件本地保存 | 上传后只落到当前项目 assistant 目录；未点击发送前不调用 Provider；本地 URL 可读取 | PASS |
| A08 | 附件限制与安全 | 空文件、非法 MIME、单附件超限、单消息附件数超限、总大小超限、重复 ID、不存在 ID、路径穿越文件名 | PASS |
| A09 | 文档抽取 | PDF、DOCX、XLSX、CSV、TXT/Markdown 的本地抽取、字符上限和来源关联 | PASS |
| A10 | 图片 vision 路由 | 支持 vision 时使用结构化 `input_image`，先确认外发；不把本地绝对路径放入 Provider 输入 | PASS |
| A11 | 无 vision Provider | 图片保存为 `project_reference`，不调用 vision，不声称已分析，并记录跳过事件 | PASS |
| A12 | 音视频/字幕 | MP3、MP4、SRT 保留为本地项目引用，不进行第一版内容分析，不自动外发 | PASS |
| A13 | 外发确认 | 首次按会话/Provider 阻塞在 `awaiting_external_confirmation`；确认后恢复同一个 run，不重复消息 | PASS |
| A14 | 外发拒绝/复用/重置 | 拒绝后附件仍可读；同 Provider 可复用；切换 Provider 重新确认；手动重置后再次确认 | PASS |
| A15 | 运行生命周期 | `run_started`、item 生命周期、`run_interrupted`、`run_completed`、`run_failed` 和 checkpoint | PASS |
| A16 | 事件重放 | `after_sequence` 只返回断点之后事件；序列连续；刷新后会话、消息、计划和事件可恢复 | PASS |
| A17 | 中止运行 | 等待外发确认时可中止；Provider 请求运行中可中止；不生成计划、不丢消息和附件 | PASS |
| A18 | Provider 失败 | 运行标记 failed，错误可见；用户消息、附件和历史记录保留 | PASS |
| A19 | Prompt 候选规范 | 使用现有 normalize/canonicalize/assess 链；自动补齐 Prompt Contract 字段；QA 保持 Pending | PASS |
| A20 | Story/Storyboard 候选规范 | 复用 `StoryDocumentUpdateV3`、`_validate_storyboard_output()`、`story_checks()`；重复镜头 ID 等错误被拒绝 | PASS |
| A21 | Audio 候选规范 | 使用当前 MiniMax Speech Web 字段，逐镜头拆分，保留 providerText/sourceText 分离，不能伪造已确认 | PASS |
| A22 | 禁止伪造状态 | Provider 返回 Approved/registered/generated 等伪造字段时，运行失败，不生成可应用计划 | PASS |
| A23 | 计划审阅 | 结构化候选、来源附件、文本/JSON 差异、逐项选择、全选安全项、清空、拒绝 | PASS |
| A24 | 受保护操作后端门禁 | `blocked` 操作即使绕过前端直接提交也返回 422，流程图不改变 | PASS |
| A25 | 跨工作区应用 | 故事、资产元数据、Prompt、Audio、时间线、Workflow 操作逐项应用；未勾选项保留候选 | PASS |
| A26 | 并发与事务 | 项目/图/时间线 revision 冲突禁止写入；后续操作失败时前序 candidate row 和项目修改整体回滚 | PASS |
| A27 | active 资产保护 | Prompt 应用生成新 Prompt version，QA 保持 Pending；不覆盖 active 媒体、登记状态和历史版本 | PASS |
| A28 | 桌面 UI 会话 | 打开 Agent 工作台、三栏布局、Skill、上下文、Provider 能力、手动改名、搜索、归档/恢复、关闭/重开和会话加载 | PASS |
| A29 | 桌面 UI 附件 | 文件选择、多附件、上传状态、失败重试、移除当前消息引用、拖拽/剪贴板图片；图片外发确认卡片 | PASS |
| A30 | 桌面 UI 恢复与审阅 | 外发确认继续、自然语言回复、来源引用、重新生成、事件重放、差异、规范过期锁定和应用结果 | PASS |
| A31 | 现有工作台回归 | 首页、项目管理、故事、资产生产工作区、时间线、声音工作区、Provider 设置和已有资产画布行为 | PASS |
| A32 | Provider 输入预算 | 大型项目完整历史不直接外发；当前状态、稳定 ID、镜头和规范保留；项目上下文与附件文本共享安全预算并记录截断 | PASS |

## 本轮发现并修复的问题

1. 后端 `apply` 接口原先只依赖前端禁用 `blocked` checkbox，绕过前端仍可能提交受保护工作流删除操作。现在服务端在选中操作后重新检查 `risk == "blocked"`，返回 422 并保持计划/图不变。
2. Provider 不支持 vision 时，图片虽然正确保存为本地引用，但运行事件缺少明确的跳过记录。现在会产生 `vision_analysis / skipped` 事件并说明 Provider 能力或图片大小原因。
3. 助手工作台刷新会话时只恢复最新 run，没有读取持久化事件。现在刷新会同时请求 `assistantRunEvents`，按 sequence 恢复事件时间线。
4. SSE 的 `snapshot_complete` 是流结束标记，不应显示为普通 Agent item；现在前端忽略该标记，避免出现无标题的伪事件。
5. `item_completed` 的来源引用/图片分析/Provider 请求此前都显示成泛化的“处理完成”。现在优先用 item ID 显示“来源引用”“图片分析”“Provider 请求”等语义标签。
6. MiniMax Web 页面设置提示与已有测试规范措辞不一致，已统一为“不要粘贴到 MiniMax 文本框”。
7. 资产 Prompt 候选应用原先可能把现有 ready 资产的 `generationStatus` 降级为 planned；现在保留 active/登记历史字段，只新增 Prompt candidate 并将 Prompt QA 保持 Pending。
8. 附件文件名原先会静默归一化路径穿越片段；现在显式拒绝包含 `/`、`\\` 或 NUL 的文件名并返回 422，正常文件名继续安全保存。
9. 会话列表原先缺少最近消息、手动标题、搜索和右侧 Provider/资产画布上下文；现在这些信息均由项目隔离接口和桌面 Agent 工作台展示。
10. 规范 hash 变化原先只在 apply 返回冲突；现在首次检测到变化会冻结 `agent_plans_v5` 计划、持久化 stale 原因和事件，前端同步锁定计划并给出按最新规范重新生成入口。
11. 当前项目的原始 Assistant 输入达到 556,208 字符，超过 OpenCode 120,000 字符限制；根因是完整 `project_document` 携带大型历史数组和重复 Prompt，其中 `assetPromptRuns` 约 268,630 字符、`storyboardVersions` 约 62,075 字符。现在只向 Assistant 提供有上限的当前状态视图：保留剧本、场次、镜头、稳定资产 ID、状态、关键 Prompt 锚点和历史摘要，完整项目原文不被改写。
12. 压缩后的 Provider 输入采用 96,000 字符安全预算，并为系统/协议预留空间；文档抽取文本与 vision 观察结果也会按剩余预算共享截断，事件记录实际 input budget 和各部分长度，不再把超限错误留给 Provider。
13. E2E 项目切换夹具存在同名项目与异步项目管理弹窗竞态；现在按项目 ID 精确定位、等待弹窗卸载，并修复打开项目管理时重复异步打开的问题，避免测试误报遮挡或旧项目残留。
14. `frameflow/audio_assistant.py` 的四个字典推导式曾包含多余的 `if` 尾随逗号，导致新进程冷启动导入时出现 `SyntaxError`；现已修复，并通过 Python 源码编译检查，避免依赖旧 `.pyc` 缓存掩盖问题。
15. 新增失败运行“重新生成”按钮后，附件管理 E2E 中同名“重试”按钮触发 Playwright 严格模式冲突；现已将测试定位限定在失败附件行内，最终 17/17 桌面回归通过。

## 执行命令与结果

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
# Ran 207 tests ... OK

npm test -- --run
# 10 test files, 52 tests passed

npm --prefix web run build
# tsc + vite build + bundle gate passed; latest largest raw JS chunk 417.51 KB

PATH="$PWD/.venv/bin:$PATH" npm --prefix web run test:e2e
# 17 passed (7 Assistant + 10 workbench)
```

专项测试文件：

- `tests/test_assistant_workspace.py`：34 条后端助手独立验收用例。
- `web/src/assistant-state.test.ts`：事件 sequence 去重、受保护操作选择和逐项 toggle。
- `web/tests/e2e/assistant.spec.ts`：7 条助手桌面 E2E。
- `web/tests/e2e/workbench.spec.ts`：10 条已有工作台回归 E2E。

## 真实 8787 服务只读检查

`/api/system/doctor` 返回：

- `frontend_ready=true`
- `schema_version=18`
- `project_storage_error=null`
- `resource_dir=/Users/yusu/Desktop/framflow v3 resource`
- `data_dir=/Users/yusu/Desktop/framflow v3 resource/data`
- `database=/Users/yusu/Desktop/framflow v3 resource/data/frameflow.db`
- `keyring_available=true`

`/api/v2/settings` 返回 `feature_flags.assistant_workspace_v2=true`；当前 orchestrator 绑定为本机 OpenCode 且健康，MiniMax TTS 当前就绪，OpenAI 图片/vision、即梦视频等能力仍按独立状态显示未就绪；最终 `/api/health` 为 `ready`（`ok=true`、`ready=true`），未就绪媒体能力不会被助手伪造为已分析或已生成。本轮没有使用真实用户资源执行 Provider 生成，也没有把用户文件外发，Provider 付费/外部调用路径由隔离测试和桌面 mock E2E 覆盖。

## 仍需用户确认的事项

- 本轮没有提交 Git，也没有推送 GitHub；等用户在 1440×900 桌面端验收确认后，再按方案执行本地 `main` 提交和 `origin/main` 推送。
- 本机 `.env` 中的 `FRAMEFLOW_RESOURCE_DIR` 和助手 feature switch 已配置，但 `.env` 不纳入提交。
- 真实图片 vision、即梦视频生成仍取决于用户在设置中配置有效 Provider；各媒体能力独立受 Provider 状态控制，不会阻塞本地附件保存、文档抽取、会话、计划审阅和安全应用。
