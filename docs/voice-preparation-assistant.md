# FRAMEFLOW 声音工坊内嵌 AI 操作手册

声音 AI 属于声音资产工坊自身，不是通用 `AssistantWorkspace` 的可见模式。它位于声音工坊顶部，读取当前声音草稿、当前焦点、镜头引用、已有 Voice Profile / audition / dialogue 和 MiniMax 系统音色目录。

声音工坊的日常创作区采用“声音 AI 导演 → MiniMax 创作器 → 角色声音库”的顺序。角色库会在故事 / 分镜 revision 变化后重新读取结构化角色、镜头和对白，形成待建立声音队列；队列只是建议，不会绕过用户审阅直接写入 Profile 或调用 Provider。点击“AI 完善”后，OpenCode 才在对应焦点中补充性格、关系、语言和可观察的声音表现方向。

## 职责边界

- OpenCode 负责理解自然语言想法、追问缺失信息、把“甜”“轻柔”“有活力”“不要人机感”等模糊描述转换成可观察的语速/音调/能量/停顿/发音要求，并提出系统音色、目标语言台词、三组 audition 和 MiniMax preflight 候选。
- MiniMax 只负责用户明确点击并确认费用后的实际 TTS。声音 AI 对话不会调用 MiniMax，不确认费用，不创建 Take / artifact，不提交 QA，也不锁定 production-ready。
- “应用到声音草稿”只返回浏览器内的未保存草稿。用户检查后继续使用声音工坊已有保存流程；应用不会增加项目 revision，也不会覆盖已批准 profile、Take 或 artifact。

声音助手运行固定标记为 `assistant_mode=voice-preparation`、`skill_id=voice-preparation-assistant`，下一路由为 `voice-controller`。通用 Agent 的 Apply 入口不能应用声音方案，必须使用声音工坊专用的 `audio-draft` 入口。

## 推荐操作顺序

```text
在顶部输入声音想法
  → 阅读声音目标理解与待确认问题
  → 选择 MiniMax system preset 和目标语言台词候选
  → 勾选要回填的 profile / audition / dialogue 草稿
  → 应用到当前本地草稿
  → 检查下方表单并保存
  → 点击“确认台词”写入 sourceText/providerText 的确认 hash
  → 查看 MiniMax preflight 并单独确认费用
  → 逐句生成一个新的 audition / Take
  → 播放并完成 generated-pending-qa 的声音 QA
```

## 规则化输入与候选

首期默认使用 MiniMax 官方 system preset。`live` / `cached` 目录可应用和生成，`documented` 只能显示为参考，`unavailable` 不能生成。音色 ID 的名称不能单独证明年龄、性别、自然度或最终适配度；必须通过同一文本试听与 QA 决定。

目标语言同时记录 `locale`、`language`、`dialect` 和 `language_boost`。例如日语任务使用：

```json
{
  "locale": "ja-JP",
  "language": "Japanese",
  "dialect": "Standard Japanese",
  "language_boost": "Japanese"
}
```

中文解释只显示在助手卡片中，不进入 MiniMax 文本框。助手可以提出日语候选，但候选默认是 `candidate`，不能自动成为 `confirmed`。`sourceText` 保存用户确认的原始台词，`providerText` 保存实际发送给 MiniMax 的文本；资产 ID、合同、镜头、环境声、QA、混音和授权说明不能进入 `providerText`。

三组 audition 使用同一条短文本：`neutral`、`emotional`、`pronunciation-stress`。首轮不添加 `(breath)`、`(chuckle)` 或 `<#x#>`，第二轮只改变一个变量，以便分辨人机感来自音色还是参数。每条对白和 audition 都是独立生成任务，不把多个镜头合并为一个请求。

## 生成前门禁

正式或试听生成必须同时满足：

1. 声音 profile 存在并绑定实时/缓存目录中的 `provider_voice_id`。
2. Provider、区域、模型和语言配置一致；日语任务不能带旧的 `Chinese` 增强值。
3. `sourceText` 已由用户确认，`providerText` 通过 MiniMax 文本校验，确认 hash 与当前记录一致。
4. 生成参数通过 MiniMax 规则：默认模型 `speech-2.8-hd`，格式 `mp3` / `wav` / `flac`，语速 `0.5–2.0`，音调 `-12–12`，音量在允许范围内。
5. 用户在当前生成操作前明确确认费用。

API 请求成功只代表 Provider 返回了文件。结果先进入 `generated-pending-qa`，必须完成文本、目标语言发音、语速、停顿、句尾语调、机械节拍、音高稳定、动漫腔、断裂/重复/截断、音色连续性、情绪、技术音频和授权 QA；失败时创建新 Take，不覆盖历史版本。

如果生成请求超时或状态不确定，标记为 `execution-unknown`，不跨区域自动重放，避免上游已成功时重复计费。

## 会话与草稿隔离

声音准备会话按项目隔离，并与故事、分镜、视觉和时间线的通用 Agent 会话分开。多轮对话会继续读取当前声音草稿、最近一次有效方案、用户选择/拒绝的候选、确认状态、目录状态和未解决问题。草稿应用接口只允许六类声音草稿操作：

```text
create_voice_profile_draft
update_voice_profile_draft
create_audition_draft
update_audition_draft
create_dialogue_draft
update_dialogue_draft
```

服务端会重新读取当前项目和声音草稿、重新验证目录与版本、过滤 OpenCode 越权字段，并拒绝生成、登记、QA、交接和覆盖已批准记录的操作。

## 当前日本女高中生测试

推荐先用以下文本和候选，不直接预设最终音色：

```text
先輩、今日の放課後、一緒に帰りませんか？
```

```text
Japanese_SportyStudent
Japanese_OptimisticYouth
Japanese_GracefulMaiden
```

三种音色统一使用 `speech-2.8-hd`、`language_boost=Japanese`、语速 `1.0`、音调 `0`、不加标签。先听基础音色，再只改一个变量。锁定前必须以实际试听和声音 QA 为准。
