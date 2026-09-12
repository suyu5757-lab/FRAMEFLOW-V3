# Prompt 生成规则备份

这是 2026-09-12 在修改人物、物品和环境基础资产 Prompt 规则之前保存的当前实现快照。该快照包含后端编译器、前端镜像编译器、资产 Prompt 编排入口以及结构化 Prompt schema；融合资产规则仍可从 `server.py` 和 `frameflow-prompt_design.py` 的原始版本恢复。

本次修改范围：

- 人物（`character`）基础资产 Prompt
- 物品/道具（`prop`，以及规范化后对应的物品别名）基础资产 Prompt
- 环境/场景（`scene`）基础资产 Prompt

本次明确不改动：

- 融合资产（`fusion`）的 Prompt 生成与连接后定向流程
- 现有 Prompt 版本、QA 和图片生成确认门禁

备份文件：

- `frameflow-prompt_design.py`
- `web-prompt-design.ts`
- `frameflow-providers.py`
- `server.py`

这些文件是备份时工作树中的完整文件，而不是只保留的片段。备份时 SHA-256：

```text
0fe87eaa5ae6e700984dd94547570b9219a8f14ddf73f5aedbfa906069eab910  frameflow-prompt_design.py
16fe72b3ee8c21f952c3f57cf8ae6c4322ac9708b71399aff05946973676313f  web-prompt-design.ts
54b10f074e8aee64ca05623ae4589f31da77a14d6f784b9076a172ec38daf28b  frameflow-providers.py
af6a3786c6ec792ebb425b6bb1d6f567f94b17d06312c2d610d204b10b8c4464  server.py
```
