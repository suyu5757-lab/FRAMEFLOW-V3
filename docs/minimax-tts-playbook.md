# FRAMEFLOW MiniMax 多语言 TTS 操作手册

本手册对应 `minimax-speech-audio-v2`。声音工坊的日常路径是 MiniMax 官方系统音色；Voice Design 和 Voice Clone 只在用户明确选择高级路径时使用。本项目不安装或维护本地 TTS 模型，也不把 GitHub 仓库作为运行依赖。

## 创作者优先的声音工坊入口

声音资产工坊默认打开三段式创作台：顶部是声音 AI 对话，中部是 MiniMax 式声音创作器，下部是剧本角色声音库和逐句台词队列。AI 只整理想法、语言、音色候选、Voice Design 文案和台词草稿；实际音色预览、Demo 和正式台词仍由用户在 MiniMax 操作区单独确认费用后触发。

角色声音先建立，再生成正式台词。剧本变更会自动更新结构化角色 / 对白待处理队列，但不会静默创建 Voice Profile、生成音频或提交 QA。专业参数、Take 历史、QA、登记、音乐和音效保留在“高级制作与交接”中。

## 推荐工作流

```text
选择 locale / 语言
  → 刷新当前区域的 MiniMax 系统音色目录
  → 选择 voice_id
  → 使用同一条短句建立 neutral / emotional / pronunciation-stress 三个 audition
  → 每条单独确认费用并生成一个 Take
  → 播放并完成声音 QA
  → 锁定 voice_id 与 Approved Take
```

首轮不要同时改变音色、台词、情绪、速度和音调。否则无法判断人机感来自音色还是参数。推荐的日本女高中生首轮文本是：

```text
先輩、今日の放課後、一緒に帰りませんか？
```

首轮候选：

- `Japanese_SportyStudent`：先验证学生感与活力。
- `Japanese_OptimisticYouth`：先验证明亮、朝气和句尾上扬。
- `Japanese_GracefulMaiden`：先验证柔和、甜美和较少的机械感。

这些名称只是筛选线索，不能推断最终年龄、性别或自然度；最终选择必须依据实际试听和 QA。

## Voice Design 双路径

选择“新建音色”后，声音 AI 输出两个独立字段：`prompt`（音色描述）和 `preview_text`（试听文本）。用户可以：

- 点击“复制到 MiniMax Web”，只复制 Voice Design 执行包，不产生费用；
- 点击“创建音色预览”，在当前 MiniMax 区域执行一次付费预览，返回候选 `voice_id` 和试听文件。

工作台保存 Voice Design 结果为 `voice_design_candidates`，候选不会自动进入 `voices`，也不会自动成为角色声音。用户必须先试听并点击“采用为角色声音”，再建立三组 audition、完成 QA 和锁定。MiniMax 自定义 Voice ID 需要在 7 天内用于语音合成，否则可能被上游删除；工作台不会自动调用 TTS 来维持它。

Voice Design 接口为：

```text
POST /api/v2/projects/{project_id}/audio/voice-design
```

接口要求 `confirmed=true`、当前项目 revision、`prompt` 和不超过 500 个字符的 `preview_text`。中国区与国际区沿用当前选中的 MiniMax 路由；连接状态不确定时不自动重试，也不跨区域切换。

## 语言与区域

工作台保存 `locale`、`language`、`dialect` 和 `language_boost`。MiniMax Provider 还分别保存 `cn` 与 `global` 两个系统凭据槽位；当前执行区域由 Provider 的 `model_config.region` 决定，切换后探测、音色目录和 TTS 请求都只读取对应区域的 Key。例如：

```json
{
  "locale": "ja-JP",
  "language": "Japanese",
  "dialect": "Standard Japanese",
  "language_boost": "Japanese"
}
```

工作台语言选择器按 Speech 多语言目录提供 40 个语言/地区入口：`ja-JP → Japanese`、`zh-CN → Chinese`、`en-US → English`、`ko-KR → Korean`、`fr-FR → French`、`de-DE → German`、`es-ES → Spanish`、`it-IT → Italian`、`pt-BR → Portuguese`、`ru-RU → Russian`、`ar → Arabic`、`tr → Turkish`、`nl → Dutch`、`uk-UA → Ukrainian`、`vi → Vietnamese`、`id-ID → Indonesian`、`th-TH → Thai`、`ms-MY → Malay`、`fil-PH → Filipino`、`pl-PL → Polish`、`ro-RO → Romanian`、`cs-CZ → Czech`、`el-GR → Greek`、`hu-HU → Hungarian`、`sv-SE → Swedish`、`da-DK → Danish`、`fi-FI → Finnish`、`no-NO → Norwegian`、`sk-SK → Slovak`、`bg-BG → Bulgarian`、`hr-HR → Croatian`、`ta-IN → Tamil`、`te-IN → Telugu`、`hi-IN → Hindi`、`he-IL → Hebrew`、`fa-IR → Persian`、`bn-BD → Bengali`、`af-ZA → Afrikaans`、`ca-ES → Catalan`、`sr-RS → Serbian`。未明确语言时省略 `language_boost`，让 Provider 自动识别；旧数据里的 `Chinese` 不得覆盖新的日语 locale。

区域和 Base URL 必须成对保持一致：

- `cn`：`https://api.minimax.cn/v1`
- `global`：`https://api.minimax.io/v1`

探测可以在同一区域使用官方备用地址。TTS 生成是可能计费的 POST；超时或连接中断时工作台标记 `execution-unknown`，不跨区域、不自动重放，避免上游已经成功后重复计费。

## API 请求边界

当前默认模型是 `speech-2.8-hd`。同步 T2A 的文本必须少于 10,000 个字符；工作台按 9,999 个字符校验。格式只允许 `mp3`、`wav`、`flac`，语速是 `0.5–2.0`，音调是 `-12–12`，音量使用 MiniMax 允许范围。

工作台的 provider-neutral 请求与 MiniMax 字段转换如下：

```text
sourceText       → 仅用于历史和 QA
providerText     → text
providerVoiceId  → voice_setting.voice_id
speed            → voice_setting.speed
volume           → voice_setting.vol
pitch            → voice_setting.pitch
emotion          → voice_setting.emotion（用户明确选择时才发送）
languageBoost    → language_boost
format           → audio_setting.format
```

`instructions` 是内部 QA/表演备注，不会伪装成 MiniMax T2A 字段。可执行控制只使用模型支持的参数：语速、音调、音量、情绪、合法停顿、发音词典和 Speech 2.8 非语言标签。

`sourceText` 是用户确认的原始台词；`providerText` 是实际发给 Provider 的文本，可以在明确需要时包含合法 `<#x#>` 停顿或 Speech 2.8 标签，例如 `(breath)`。第一轮默认不加标签。资产 ID、合同版本、镜头说明、中文翻译、环境声、QA 和授权说明永远不能放进 `providerText`。

## Web 版与 API 版

- MiniMax Web（[minimax.io/audio](https://www.minimax.io/audio)）适合人工试听和备用路径。复制包分成四块：实际朗读文本、页面设置、当前声音与语言身份、FRAMEFLOW 内部 QA / 版本信息；只有第一块可以粘贴到文本框。
- FRAMEFLOW API 适合可追踪执行：每次确认只生成一个新 Take，保存 `sourceText`、`providerText`、Provider、模型、voice_id、语言、区域、参数和 trace ID。
- API 成功只表示生成文件返回，不等于声音可入片。结果状态固定进入 `generated-pending-qa`，完成听审、技术 QA、授权记录和登记后才是 `production-ready`。

## QA 最低清单

关键字段初始为空，不预填 `pass`。Approved 前逐项记录：

1. 文本逐字完整，没有额外词语、重复或截断。
2. 目标语言和口音正确；日语长音、促音、专名和句尾发音正确。
3. 语速和停顿自然；句尾语调符合当前试听方向。
4. 没有明显机械节拍、异常音高跳变或过度动漫腔。
5. 没有突发吸气、断裂、重复、削波或不可接受底噪。
6. 与已锁定 Voice Profile 的音色连续；情绪控制与音色连续性分别判断。
7. 文件格式、采样率、声道、时长、handles、AI 生成披露和授权状态齐全。

失败时创建新 Take，不覆盖 Approved 版本。`Needs revision`、`Rejected` 和 `Blocked` 都保留原文件与 QA 记录。

## 研究资料如何被采用

GitHub 资料只提炼为规则，不复制代码或安装外部 Skill：

- [MiniMax-AI/skills](https://github.com/MiniMax-AI/skills)：官方默认模型、区域参数、字符限制和结构化执行方式。
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)：将 Custom Voice、Voice Design 和 Voice Clone 分层的思想。
- [CosyVoice](https://github.com/QwenAudio/CosyVoice)：多语言、文本规范化、发音与节奏 QA 思路。
- [Chatterbox](https://github.com/resemble-ai/chatterbox)、[ChatTTS](https://github.com/2noise/ChatTTS)、[Coqui TTS](https://github.com/coqui-ai/TTS)：只借鉴试听、口语节奏和工具链经验，不进入本地运行路径。
- [TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite)：逐段生成、局部重生成和版本缓存思路。

MiniMax 官方接口参考：[T2A HTTP](https://platform.minimax.io/docs/api-reference/speech-t2a-http)、[API Overview](https://platform.minimax.io/docs/api-reference/api-overview)、[Speech 模型说明](https://platform.minimax.io/docs/guides/models-intro)、[系统音色 ID](https://platform.minimaxi.com/docs/faq/system-voice-id)。
