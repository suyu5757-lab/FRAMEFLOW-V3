# MiniMax 音色设计、音色克隆、语音生成与 GitHub 项目调研

调研日期：2026-09-09（Asia/Shanghai）
适用范围：FRAMEFLOW 的角色音色、旁白、对白、音色候选、语音生成和相关 Agent Skill 设计。
资料口径：MiniMax 官方 API 文档为能力和限制的第一来源；GitHub 的 Star、提交时间、Issue/PR 和许可证是本次项目筛选信号。Star 会变化，提交日期也会随分支和抓取时间变化，正式接入前仍需在目标区域的控制台和官方文档复核。

当前拟创建的 Skill 正式名称为 **Speech Design**，目录 slug 建议为 `speech-design`。本报告中的授权、激活、QA 和交付内容表示完整语音制作流程所需的上下游信息；它们不等于都必须由 Speech Design 本身执行。Speech Design 的直接职责是把创意整理成音色提示词和结构化语音生成输入，实际 API 执行、音频处理和最终审核可以由其他明确的工作流承担。

## 一、先给结论

### 1. 推荐的 MiniMax 组合

如果目标是搭建一条可控的生产流程，而不是只做一次试听，推荐采用三层结构：

1. **音色创作与管理层：**使用官方 [MiniMax-AI/MiniMax-MCP](https://github.com/MiniMax-AI/MiniMax-MCP)，因为它的 README 同时覆盖 `voice_design`、`voice_clone`、`list_voices` 和 TTS 等工具，适合把“创建候选音色—试听—采用—合成”接入 Agent 工作流。
2. **正式语音生成层：**使用官方 [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli)，其当前 Skill 和 CLI 参数更适合批处理、可重复执行、保存输出文件和 CI/Agent 调用。它目前的强项是 TTS，不应假设它已经覆盖 Voice Design 或 Voice Clone。
3. **流程控制层：**在这两个适配器外面增加同一套身份、授权、文本、试听、QA、版本和交付状态机。生成成功只能算 `generated-pending-qa`，不能直接进入成片。

一句话概括：**MCP 负责“造和管音色”，CLI 负责“稳定地产生台词”，流程 Skill 负责“确认什么能生成、什么能入片”。**

### 2. 不要把四种操作混为一谈

| 需求 | 正确路径 | 必要输入 | 主要结果 |
| --- | --- | --- | --- |
| 选一个现成声音朗读 | System Voice + T2A | `voice_id`、台词、参数 | 一次或一批 TTS 音频 |
| 制作虚构角色的新声音 | Voice Design | 可听见的音色描述、试听文本 | 候选 `voice_id` 和试听音频 |
| 复现一个真实说话人的声音 | Voice Clone | 有授权的原始人声、可选短参考音频和文字 | 自定义 `voice_id` |
| 保留原始表演，只改变音色 | STS/Voice Conversion | 表演音频、目标音色参考 | 转换后的表演音频 |

Voice Design 是“按描述生成一个新声音”，不是把某个真人的声音复制出来；Voice Clone 是身份敏感操作，必须有授权和可追溯证明；STS/VC 的目标是尽量保留原始语气、节奏、呼吸或演唱表演，不能用普通 TTS 代替。

### 3. 最值得优先研究的 GitHub 项目

针对 MiniMax 本身：

- **第一优先：**[MiniMax-AI/MiniMax-MCP](https://github.com/MiniMax-AI/MiniMax-MCP)——功能覆盖最接近“完整音色制作工作台”，当前仓库页面约 1.6k stars，提交历史显示 2026-08-20 仍有模型和 MCP SDK 相关更新。
- **第一优先：**[MiniMax-AI/cli](https://github.com/MiniMax-AI/cli)——TTS 自动化最实用，当前仓库页面约 2.1k stars，提交历史显示 2026-09-07 仍在更新。
- **资料和 Skill 底座：**[MiniMax-AI/skills](https://github.com/MiniMax-AI/skills)——约 1.35 万 stars，包含 MiniMax TTS 参考、音色目录和脚本，但当前可见提交节奏慢于 CLI/MCP，内容要以官方 API 复核后再固化。

针对本地研究和备用方案：

- **音频数据预处理和微调：**[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)。社区规模最大、维护活跃，适合学习切片、ASR、人工校对、数据集和微调闭环；它不是 MiniMax API 适配器。
- **表达力、标签和参考音频控制：**[Fish Speech](https://github.com/fishaudio/fish-speech)。资料和能力很丰富，但模型采用 Fish Audio Research License，商业使用前必须单独审查。
- **多语言与发音控制：**[CosyVoice](https://github.com/QwenAudio/CosyVoice)。适合研究文本规范化、拼音/音素、跨语言克隆和流式延迟；代码为 Apache-2.0。
- **Voice Design → Clone 的清晰分层：**[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。适合做本地基准和理解可复用音色提示词的生命周期；不是 MiniMax 适配器。
- **Apple Silicon 本地备用：**[mlx-audio](https://github.com/Blaizzy/mlx-audio)。当前页面约 7.9k stars，2026-09-07 仍有提交，适合在 Mac 上做本地 TTS/STT/STS 实验；它的模型许可要按具体模型分别检查。

## 二、MiniMax 官方能力与限制

### 1. TTS 模型和接口形态

MiniMax 的官方 API 总览把语音能力分为语音合成、音色克隆和音色设计，并列出 40 种语言和 300+ 系统音色。当前文档列出的主要模型包括 `speech-2.8-hd`、`speech-2.8-turbo`、`speech-2.6-hd`、`speech-2.6-turbo`、`speech-02-hd` 和 `speech-02-turbo`。正式执行前应以目标账号、区域和官方当前文档为准：[API Overview](https://platform.minimax.io/docs/api-reference/api-overview)。

T2A v2 的核心调用是：

```text
POST /v1/t2a_v2
```

国际区域的官方示例地址是 `https://api.minimax.io/v1/t2a_v2`。官方 T2A HTTP 文档说明：

- 同步文本长度必须小于 10,000 个字符；超过约 3,000 字符时应优先考虑流式传输。
- 长文本可以进入异步流程，官方 API 总览给出的单次上限为 1,000,000 个字符，并可取得句子级时间戳。
- 同步/流式/异步分别适合低延迟试听、逐句对白和长篇旁白；不要把整部剧本默认当成一次同步请求。
- `voice_setting` 负责 `voice_id`、语速、音量和音调；`audio_setting` 负责采样率、码率、格式和声道；还可以使用 `language_boost`、发音词典和 `voice_modify`。
- 非流式输出支持 `mp3`、`wav`、`flac` 等格式；字幕信息可以按句或按词返回，具体模型支持要按当前文档核对。

详细字段和示例见 [T2A HTTP API](https://platform.minimax.io/docs/api-reference/speech-t2a-http)。

### 2. 语速、停顿、发音和非语言标签

MiniMax 当前 T2A 文档支持几种容易影响听感的控制：

- 合法停顿标记：`<#x#>`，其中 `x` 为秒数，范围为 0.01–99.99，最多两位小数；不能连续堆叠。
- 普通文本中的段落换行可以帮助组织停顿；不要把内部镜头说明、QA 备注、资产 ID 直接拼进发送文本。
- 中文普通话可以用带声调的拼音标注，英文或其他语言可按文档使用 IPA；粤语可以使用 Jyutping 声调标注。
- `speech-2.8-hd` 和 `speech-2.8-turbo` 支持一组非语言标签，例如 `(laughs)`、`(breath)`、`(sighs)`、`(inhale)`、`(exhale)` 等。标签不是所有模型通用，不能无条件下发给旧模型。
- `language_boost` 主要是帮助文本识别和语言选择，不等于把克隆音色的原始口音迁移到目标语言。

工程上建议把 `sourceText` 和 `providerText` 分开：前者是用户确认的原始台词，后者才允许在明确记录后加入合法停顿、发音词典或非语言标签。

### 3. Voice Design：从文字描述生成候选音色

官方接口为：

```text
POST /v1/voice_design
```

必需字段是 `prompt` 和 `preview_text`，其中 `preview_text` 上限为 500 个字符；可以自定义 `voice_id`，否则由服务生成。响应包含 `voice_id` 和试听音频（通常以 hex 形式返回）。参考：[Voice Design API](https://platform.minimax.io/docs/api-reference/voice-design-design)。

`prompt` 不是角色小传，也不是情节说明。它应该描述听众能从声音中直接听见的特征，例如：

```text
语言/地区：普通话，轻微北方标准口音；
年龄印象：年轻成年人，不要幼态；
音域：中高音，音高稳定；
音色：清亮、略带空气感，颗粒细，近距离录音感；
发声：咬字清楚，句尾自然收束；
节奏：中速，停顿短而有目的；
基准情绪：冷静、友善、略有好奇；
避免：过度动漫腔、鼻音过重、夸张气声、机械节拍。
```

试听文本要能覆盖目标角色的真实工作场景，最好含有专名、数字、长短句和目标语言的典型音素，但不要把版权说明、镜头说明或内部元数据放进去。第一条试听可保持中性，后续再用相同文本做情绪和发音压力测试。

Voice Design 返回的是**候选音色**，不是已经锁定的角色声音。建议保存：`prompt`、`preview_text`、区域、模型、返回的 `voice_id`、试听文件、生成时间、费用确认记录和候选状态。试听合格后，仍需明确执行“采用为角色声音”，再进入统一的 audition 和 QA。

### 4. Voice Clone：从有授权的人声生成自定义音色

官方克隆流程是两步上传加一次克隆调用：

1. 通过 [Upload Clone Audio](https://platform.minimax.io/docs/api-reference/voice-cloning-uploadcloneaudio) 上传源音频，`purpose=voice_clone`。当前官方限制为 `mp3`、`m4a`、`wav`，长度 10 秒到 5 分钟，文件不超过 20 MB。
2. 可选地通过 [Upload Prompt Audio](https://platform.minimax.io/docs/api-reference/voice-cloning-uploadprompt) 上传小于 8 秒的参考片段，并提供与片段匹配的文字。该 `clone_prompt` 主要用于提高相似度和稳定性。
3. 调用 [Voice Clone API](https://platform.minimax.io/docs/api-reference/voice-cloning-clone)，传入 `file_id` 和合法的自定义 `voice_id`；需要预览时，再传 `text` 和对应的 `model`。

克隆源音频的硬限制和高质量建议要分开记录。硬限制来自官方 API；质量建议来自官方 Skill 资料和音频生产经验：单一说话人、无 BGM、无混响、无削波、底噪低、口齿清晰、音量稳定、句式和语调有足够变化。正式生产前，最好保留一份原始音频 hash、转写文本和人工校对记录。

克隆接口还支持：

- `text_validation` 和 `accuracy`：让服务用 ASR 结果检查克隆输入是否与文字相符，避免把错读或错误转写固化到音色流程中。
- `need_noise_reduction`、`need_volume_normalization`：作为上游处理选项，但不能替代自己的技术 QA。
- `clone_prompt`：用小参考片段和 `prompt_text` 补充目标说话人的稳定特征。
- 预览文本和非语言标签：用于试听，不等于完成生产登记。

最重要的一点是：**克隆预览本身不应被当成长期激活。**官方 FAQ 说明，生成的自定义音色如果没有在约 7 天（168 小时）内用于正式语音合成，可能会失效或被删除；只有真正使用 T2A/异步 TTS 合成，才会进入可持续使用状态。预览、候选和正式激活必须在数据模型中区分。参考：[About APIs FAQ](https://platform.minimax.io/docs/faq/about-apis)。

### 5. 音色管理、区域和凭证

官方音色管理接口支持查询系统音色、克隆音色和设计音色：[Get Voice](https://platform.minimax.io/docs/api-reference/voice-management-get)。音色目录是动态资源，不能只把 GitHub 文档中的一份列表复制进生产数据库。应该在当前区域调用查询接口，然后缓存带时间戳的快照。

官方 MiniMax MCP README 区分了全球和中国大陆的 API Host，并强调 Key 与 Host 必须匹配：全球通常使用 `https://api.minimax.io`，大陆区域通常使用 `https://api.minimaxi.com`。不同 SDK、旧文档和第三方仓库里可能仍会出现旧地址，不能静默跨区域替换。参考：[MiniMax-MCP 区域说明](https://github.com/MiniMax-AI/MiniMax-MCP)。

生成请求本身可以按“只处理本次输入”的方式理解，但自定义 `voice_id` 是另一个具有生命周期的资源；不要把“单次 T2A 调用无业务状态”和“自定义音色不会被保存”混为一谈。API Key 应只放在服务端或受控 MCP 进程中。

### 6. 费用和执行确认

当前官方 PayGo 页面列出的参考价格包括：`speech-2.8-hd` T2A 约 100 美元/百万字符，`speech-2.8-turbo` 约 60 美元/百万字符，Voice Design 约 3 美元/个，Rapid Voice Clone 约 1.5 美元/个；具体还会受区域、账户和计费版本影响，参考 [PayGo Pricing](https://platform.minimax.io/docs/guides/pricing-paygo)。

需要特别留意官方文档之间的价格差异：Voice Design 接口页曾显示预览按 30 美元/百万字符计费，而当前 PayGo 页面显示 API 预览按 60 美元/百万字符计费。实现时不要把任一数字永久写死，应在执行前显示当前区域、模型、预览/正式合成类型和预计字符数，并让用户确认。

超时后的 POST 不能简单自动重试：上游可能已经成功并产生费用。建议将这类状态记为 `execution-unknown`，先用 trace ID、任务查询或资源查询核实，再决定是否继续。

## 三、完整的生产流程

推荐的状态流如下：

```text
创作意图与脚本
  → 选择操作分支
  → 授权/区域/费用 Gate
  → 准备 Voice Design Prompt 或 Clone Audio
  → 生成候选 voice_id
  → 用户采用
  → 激活与三组 Audition
  → 按句/按段 TTS
  → 文本、发音、连续性、技术与授权 QA
  → 注册 Approved Take
  → 交给剪辑、字幕和混音
```

### 阶段 0：明确创作对象

先写清楚这是：系统音色、虚构音色、授权真人音色，还是保留原始表演的音色转换。没有这一步，最容易出现“用 Voice Clone 制作一个本来应该 Voice Design 的虚构人物”或“用 TTS 重建一段需要保留表演节奏的表演音频”。

### 阶段 1：建立四张卡

每个角色或旁白至少有以下四张卡：

1. **Voice Identity：**语言、地区/口音、年龄印象、音域、音色纹理、明暗、气声、颗粒感、咬字、基准能量和明确的避免项。
2. **Performance Direction：**中性、兴奋、疲惫、压低声音、紧张、悲伤等表演方向；速度和停顿要与音色身份分开描述。
3. **Spoken Text：**用户确认的原始台词、专名、数字、发音备注和版本号。
4. **Delivery Spec：**区域、模型、voice_id、格式、采样率、声道、响度处理、字幕/时间戳需求和交付路径。

Voice Design 的 `prompt` 主要来自第一张卡；单句 TTS 的 provider text 主要来自第三张卡；第二和第四张卡不应直接伪装成 T2A 的未知字段。

### 阶段 2：授权和安全 Gate

真人克隆在生成前必须至少记录：说话人身份、授权证据、授权目的、是否覆盖商业使用、语言和地区、有效期、撤回方式、提供商验证状态、源音频 hash。无法确认时，降级为“风格描述”或使用系统音色，不上传真人声音。

同时确认：当前区域和 Key 是否匹配，目标模型是否支持所需标签，是否需要用户确认费用，是否允许将源音频送到第三方服务。MCP 进程应保持本地和受控，上传接口只接受白名单格式，外部 URL 要防 SSRF，不要把不可信 Agent 直接暴露给任意本地路径。

### 阶段 3：生成候选音色

Voice Design 路径保存 `prompt`、`preview_text` 和 `trial_audio`；Voice Clone 路径保存源音频 hash、`file_id`、可选 prompt audio、`prompt_text`、clone 参数和返回的 `voice_id`。两条路径都只能产生 `candidate`，不能自动写入角色的锁定 `voice_id`。

如果用户要尝试多个 prompt 或多个源片段，每次应生成新的候选版本，记录“保留什么、改变什么、预期改善什么”。不要覆盖已经 Approved 的音色或 Take。

### 阶段 4：采用和激活

用户明确选择候选后，建立角色与 `voice_id` 的关系，再用一条短台词做真实 TTS 激活。激活本身可能产生费用，需要单独经过费用确认。只播放 Voice Design 或 Voice Clone 的 preview，不能假设已经完成激活。

### 阶段 5：固定三组 Audition

对每个长期角色用同一套短句试听：

- **Neutral：**无特殊情绪，检查基础音色、咬字和机械感。
- **Emotional：**与角色最常用的情绪，检查情绪控制是否破坏身份连续性。
- **Pronunciation-stress：**包含专名、数字、长音、促音、容易混淆的音素或跨语言词，检查可懂度和发音稳定性。

评价维度至少包括：音色身份、自然度、发音、情绪范围、节奏/停顿、前后句连续性、后期修复成本。第一轮只改变一个变量，避免同时改变 voice_id、台词、速度、音调和情绪后无法判断原因。

### 阶段 6：按句或按小段生成正式语音

对白和视频旁白优先按句或按 5–15 秒的小段生成，便于局部重生成、对齐镜头和保存 Take 历史。长文本异步 TTS 适合有明确长篇交付需求的场景，但仍要保留句级时间戳和失败重试策略。

每次请求至少保存：

```json
{
  "project_id": "project-...",
  "character_id": "character-...",
  "voice_id": "custom-...",
  "provider": "minimax",
  "region": "global-or-cn",
  "model": "speech-2.8-hd",
  "source_text": "用户确认的原始台词",
  "provider_text": "实际发送的台词，可含合法停顿或标签",
  "voice_settings": {
    "speed": 1.0,
    "vol": 1.0,
    "pitch": 0
  },
  "audio_settings": {
    "format": "mp3",
    "sample_rate": 32000,
    "channel": 1
  },
  "text_hash": "sha256:...",
  "trace_id": "...",
  "status": "generated-pending-qa"
}
```

真实项目还应记录 API 响应中的文件/任务 ID、创建时间、输出文件 hash、时长、采样率、声道、响度测量结果和授权记录。任何未测量的字段都写 `unmeasured`，不要把默认值冒充测量值。

### 阶段 7：多层 QA 和注册

Approved 前至少检查：

1. 文本逐字完整，无额外词、重复、漏字、截断或不必要的解释。
2. 语言、口音、专名、数字、长音、促音和发音标记正确。
3. 语速、停顿、句尾语气和情绪符合 Performance Direction。
4. 与锁定 Voice Profile 的音色连续，不出现明显人设漂移。
5. 没有突发吸气、断裂、重复、削波、底噪、混响或不可接受的合成伪影。
6. 文件格式、采样率、声道、时长、字幕/时间戳和后期编辑 handles 齐全。
7. 权利、来源、AI 生成披露和授权有效期齐全。

失败时创建新的 Take，保留旧 Take 和 QA 记录；Approved 文件不可被静默覆盖。建议状态至少有 `candidate`、`adopted`、`generated-pending-qa`、`approved`、`needs-revision`、`rejected`、`blocked` 和 `execution-unknown`。

## 四、GitHub 项目筛选结果

### A. 直接 MiniMax 项目：优先级最高

以下 Star 是 2026-09-09 抓取时的页面观察值，提交日期是公开 `main` 历史中可见的近期活动，不代表未来承诺。

| 优先级 | 项目 | 页面观察 | 适合做什么 | 判断 |
| --- | --- | --- | --- | --- |
| A1 | [MiniMax-AI/MiniMax-MCP](https://github.com/MiniMax-AI/MiniMax-MCP) | 约 1.6k stars；[提交历史](https://github.com/MiniMax-AI/MiniMax-MCP/commits/main) 可见 2026-08-20 更新 | Voice Design、Voice Clone、列出音色、TTS；Python MCP，支持 stdio/SSE | **音色制作首选。**功能覆盖最完整；需要限制本地路径、URL 和密钥暴露。仓库 Security 页面目前没有 SECURITY.md 或已发布 advisory，不能把它视为自动完成的安全审计：[Security](https://github.com/MiniMax-AI/MiniMax-MCP/security)。 |
| A1 | [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli) | 约 2.1k stars；[提交历史](https://github.com/MiniMax-AI/cli/commits/main) 可见 2026-09-07 更新 | 单句/批量 TTS、流式播放、格式、采样率、速度、音量、音调、字幕、发音、Agent 自动化 | **语音生成首选。**官方、维护活跃、CLI/JSON/dry-run 友好；当前 Skill 没有证据表明已覆盖 clone/design，因此不要拿它代替 MCP。 |
| A2 | [MiniMax-AI/skills](https://github.com/MiniMax-AI/skills) | 约 13.5k stars；[提交历史](https://github.com/MiniMax-AI/skills/commits/main) 当前可见最近活动约在 2026-04-18 | TTS 指南、音色目录、脚本、前端/多模态 Skill 参考 | **资料首选，运行依赖次之。**Star 很高，但 README/目录与部分文件存在能力描述不完全同步的问题，必须以当前官方 API 复核。 |
| A3 | [MiniMax-AI/MiniMax-MCP-JS](https://github.com/MiniMax-AI/MiniMax-MCP-JS) | 约 128 stars；[提交历史](https://github.com/MiniMax-AI/MiniMax-MCP-JS/commits/main) 当前可见近期活动约在 2025-07-22 | JS/TS MCP 的 TTS、clone、design 代码参考 | **只作迁移参考。**README 中仍可见旧的 host、模型和参数写法；新项目不应未经改造直接依赖。 |

### B. 直接 MiniMax 的小型社区项目：只提炼流程，不作为核心依赖

| 项目 | 页面观察 | 价值 | 风险 |
| --- | --- | --- | --- |
| [znyupup/pro-video-composer](https://github.com/znyupup/pro-video-composer) | 0 stars，实验性 Skill | 有“克隆—ASR—人工校对—测试 TTS—按句情绪—ffmpeg 拼接—成片交付”的完整视频音频思路 | README 使用旧的 `/v1/voice_cloning/upload_clone_audio` 和 `/v1/voice_cloning/clone` 路径，而当前官方文档是 `/v1/files/upload` + `/v1/voice_clone`；只能迁移流程思想。 |
| [Jingyi-Wu-Richael/rachel-digital-human-production](https://github.com/Jingyi-Wu-Richael/rachel-digital-human-production) | 约 1.0k stars，但只有 1 次提交 | 面向授权 MiniMax 海外克隆 + HeyGen 数字人的 preflight、15 秒预览、用户确认和状态追踪 | 场景窄，维护信号弱；适合研究授权确认 UX，不适合做通用 TTS 核心。 |
| [MiniBotFactory/minimax_TTS](https://github.com/MiniBotFactory/minimax_TTS) | 0 stars，小型 Go CLI | 代码很短，能看清上传、clone、TTS 的最小请求链 | 社区和维护信号不足，不能承担生产级重试、幂等、审计和 QA。 |
| [cytwyatt/minimax-tools-skill](https://github.com/cytwyatt/minimax-tools-skill) | 0 stars，提交很少 | 可作为 OpenClaw TTS/clone Skill 的最小样例 | 明确不覆盖 Voice Design、音色管理和长文本异步，功能面不完整。 |

### C. 高星本地/开源项目：用于理解音色制作和建立基准

| 项目 | 页面观察 | 最有用的部分 | 许可证/维护判断 |
| --- | --- | --- | --- |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 约 6.17 万 stars；[提交历史](https://github.com/RVC-Boss/GPT-SoVITS/commits/main) 可见 2026-08-18 仍有更新 | 音频切片、可选降噪、ASR、人工校对、`audio|speaker|language|text` 数据、微调和 WebUI | MIT；社区最大、维护活跃。适合数据准备和本地基准，但部署复杂，不能直接当 MiniMax adapter。 |
| [Fish Speech](https://github.com/fishaudio/fish-speech) | 约 3.26 万 stars；[提交历史](https://github.com/fishaudio/fish-speech/commits/main) 可见 2026-08-22 仍有更新 | 快速克隆、长文本、多人对话、自然语言标签和表达力控制 | Fish Audio Research License；研究很有价值，但商业部署必须先审许可证。 |
| [OpenVoice](https://github.com/myshell-ai/OpenVoice) | 约 3.7 万 stars；[提交历史](https://github.com/myshell-ai/OpenVoice/commits/main) 可见最新主线活动约在 2025-04-19 | 音色克隆、情绪/口音/节奏/停顿/语调的概念分解 | MIT，但维护明显落后于高 Star 数；只作历史和方法参考，不列入当前核心技术栈。 |
| [CosyVoice](https://github.com/QwenAudio/CosyVoice) | 约 2.35 万 stars；[提交历史](https://github.com/FunAudioLLM/CosyVoice/commits/main)（仓库已重定向）可见 2026-05-25 更新 | 多语言/方言、文本规范化、中文拼音和英文 CMU 发音、跨语言克隆、流式延迟 | Apache-2.0；文档和工程价值高，适合发音与多语言 QA 基准。 |
| [F5-TTS](https://github.com/SWivid/F5-TTS) | 约 1.52 万 stars；[提交历史](https://github.com/SWivid/F5-TTS/commits) 可见 2026-07-23 仍有版本更新 | 参考音频条件、分块、多风格/多说话人、流式和本地推理 | 代码 MIT，但预训练模型受 CC-BY-NC 等限制；不能仅看代码许可证判断商业可用性。 |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 约 1.33 万 stars；[提交历史](https://github.com/QwenLM/Qwen3-TTS/commits/main) 可见 2026-03-17 更新 | 明确的 Voice Design、Voice Clone、Custom Voice、Design→Clone、流式和微调章节 | Apache-2.0；是理解“先造声音、再复用声音”数据模型的最佳本地参考之一。 |
| [mlx-audio](https://github.com/Blaizzy/mlx-audio) | 约 7.9k stars；[提交历史](https://github.com/Blaizzy/mlx-audio/commits/main) 可见 2026-09-07 连续更新 | Apple Silicon 上的 TTS、STT、STS、多模型统一运行和本地 API/CLI | MIT 仓库；具体模型的权利和权重许可证仍需单独检查。对 Mac 开发环境尤其有用。 |
| [Seed-VC](https://github.com/Plachtaa/seed-vc) | 约 3.9k stars，但仓库已于 2025-11-21 归档 | 1–30 秒参考音频的 zero-shot VC、实时转换、表演/音色分离思路 | GPL-3.0 且已归档；只用于理解 STS/VC，不列入维护良好的首选。 |

## 五、相关 Skill 的价值和推荐用法

### 1. 直接可借用的官方 Skill 资料

- [MiniMax CLI 的 SKILL.md](https://raw.githubusercontent.com/MiniMax-AI/cli/main/skill/SKILL.md)：适合作为正式 TTS Skill 的执行骨架。值得保留的点包括 `--non-interactive`、`--quiet`、`--output json`、`--dry-run`、`--yes`、输出路径、流式开关和格式参数。它当前重点是 TTS，不应虚构出 clone/design 命令。
- [MiniMax Voice Catalog](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/references/minimax-voice-catalog.md)：适合学习按场景、年龄印象、语气、语言和角色用途筛选系统音色，以及如何写 Voice Design 描述。系统音色 ID 仍要通过当前区域的 Get Voice API 动态确认。
- [MiniMax TTS Guide](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/references/minimax-tts-guide.md)：适合作为同步 TTS、暂停标记、模型和基本参数的速查表，但与当前 API 不一致的字段、价格、区域和模型必须回到官方文档核实。
- [MiniMax TTS script](https://github.com/MiniMax-AI/skills/blob/main/skills/frontend-dev/scripts/minimax_tts.py)：适合作为最小请求脚本。脚本显式要求 `MINIMAX_API_BASE` 和 `MINIMAX_API_KEY`，使用前要检查环境变量命名、错误处理、音频 bytes 解码、重试和输出文件原子写入。

### 2. 可借鉴但不能直接安装为 MiniMax 依赖的 Skill

- [OpenAI speech Skill](https://github.com/openai/skills/blob/main/skills/.curated/speech/SKILL.md)：虽然仓库已标记 deprecated，但“保持原文逐字准确、短而明确的表演说明、一次只改一个变量、生成后逐项检查”的流程方法仍然值得借鉴；它不是 MiniMax adapter。
- [pro-video-composer 的 SKILL.md](https://github.com/znyupup/pro-video-composer/blob/main/SKILL.md)：非常适合借鉴视频对白的逐句情绪表、ASR 校对、ffmpeg 拼接和 storyboard 交接；必须把旧 MiniMax 路径迁移到当前官方接口。
- [rachel digital-human Skill](https://github.com/Jingyi-Wu-Richael/rachel-digital-human-production)：适合借鉴“授权预检—短试听—用户批准—状态登记”的 UX；它与数字人/HeyGen 绑定，不应作为通用音色 Skill。

### 3. 建议最终形成的 `speech-design` Skill 结构

这里使用用户最新确定的名称 `Speech Design`；早期讨论中出现的 `minimax-voice-production` 只是暂定描述，不再作为最终 Skill 名称。

```text
minimax-voice-production/
├── SKILL.md
├── references/
│   ├── minimax-capability-gate.md
│   ├── voice-design-prompting.md
│   ├── voice-clone-consent.md
│   ├── tts-pronunciation-and-pauses.md
│   ├── audition-and-qa.md
│   └── provider-metadata-schema.md
├── scripts/
│   ├── minimax_tts_adapter.py
│   ├── minimax_voice_design_adapter.py
│   ├── minimax_voice_clone_adapter.py
│   └── get_voice_snapshot.py
└── templates/
    ├── voice-identity.json
    ├── voice-design-request.json
    ├── clone-consent.json
    ├── audition-set.json
    └── take-manifest.json
```

Skill 的硬规则应包括：

1. 没有当前区域、模型和官方来源快照，不执行生成。
2. 没有真人克隆授权证据，不上传源音频。
3. Voice Design、Voice Clone 和 STS 使用不同的请求模板。
4. 所有收费生成都先显示区域、模型、字符数和预计费用，并等待明确确认。
5. timeout/connection reset 后标记 `execution-unknown`，不盲目重试。
6. 任何结果先进入 `generated-pending-qa`，Approved 资产不可覆盖。
7. 每次重生成必须声明 keep/change/reason/expected improvement。
8. provider text 与内部元数据分离，密钥、授权备注和镜头描述绝不发送给 T2A。

## 六、对现有 FRAMEFLOW 手册的复核建议

现有 [minimax-tts-playbook.md](./minimax-tts-playbook.md) 的整体产品方向是正确的：系统音色默认、Voice Design/Clone 显式选择、候选不自动采用、每次生成进入 QA、超时不自动重放。这些原则应保留。

在继续实现前，建议集中复核以下项目：

1. **中国大陆 Base URL：**现有手册写的是 `api.minimax.cn`；当前官方 MiniMax MCP README 给出的大陆 Host 是 `api.minimaxi.com`。应以目标账号和官方当前文档探测结果为准，并确保 Key/Host 配对。
2. **Voice Design 预览价格：**现有官方不同页面出现过每百万字符 30 美元和 60 美元两种数字。应改为运行时从当前价格页/控制台确认，不固化单一数字。
3. **克隆接口路径：**旧项目和社区 Skill 可能使用 `/v1/voice_cloning/upload_clone_audio` 与 `/v1/voice_cloning/clone`；当前官方文档应按 `/v1/files/upload`（`purpose=voice_clone`）和 `/v1/voice_clone` 实现。
4. **系统音色目录：**角色候选名称只能当筛选线索，不能写死为永久可用；每个区域应定期用 Get Voice API 建立带时间戳的快照。
5. **候选激活状态：**Voice Design/Clone 的 preview、candidate、adopted 和已通过实际 TTS 激活应是不同状态。
6. **旧模型字段：**`emotion`、非语言标签、音色修改、字幕和发音字典要按当前模型能力 Gate 后再发送，不能因为第三方 Skill 曾经支持就对所有模型下发。

## 七、最终采购/采用决策

### 可以直接进入候选技术栈

- [MiniMax-AI/MiniMax-MCP](https://github.com/MiniMax-AI/MiniMax-MCP)：音色设计、授权克隆、音色查询和 Agent 工具层。
- [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli)：TTS、批量生成、流式和 CI/脚本层。
- [MiniMax-AI/skills](https://github.com/MiniMax-AI/skills)：Prompt、目录和 Skill 资料库，先校验再采纳。
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[CosyVoice](https://github.com/QwenAudio/CosyVoice)：本地方法基准和多语言/发音研究。
- [mlx-audio](https://github.com/Blaizzy/mlx-audio)：Mac 本地快速验证和离线备用。

### 只有明确需求时才引入

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)：需要自有数据集、ASR 校对或本地微调时使用。
- [Fish Speech](https://github.com/fishaudio/fish-speech)：需要强表达力实验且许可证允许时使用。
- [F5-TTS](https://github.com/SWivid/F5-TTS)：需要研究参考音频条件生成时使用，并审查模型权利。
- [Seed-VC](https://github.com/Plachtaa/seed-vc)：需要 STS/实时变声研究时使用；已归档，不作为主线依赖。

### 不建议作为新的核心依赖

- 维护已明显落后的 OpenVoice、Spark-TTS；
- README 使用旧接口或旧 Host 的 MiniMax-MCP-JS；
- 0 Star 的小型 MiniMax wrapper；
- 把旧视频 Skill 当作当前 API 适配器；
- 把一份高 Star 的音色目录当作永久、跨区域有效的运行时配置。

本次调研没有调用 MiniMax 生成接口、上传真人音频或消耗任何付费额度；下一步如果要实现，应先做只读 capability snapshot 和本地 schema/Skill，再由用户明确确认一次真实试听或生成。
