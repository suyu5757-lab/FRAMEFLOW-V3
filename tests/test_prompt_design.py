from __future__ import annotations

import unittest

from frameflow.prompt_design import AUDIO_PROMPT_SCHEMA_VERSION, PROMPT_CONTRACT_VERSION, assess_prompt_pack, build_audio_prompt_package, build_natural_language_prompt, prompt_contract, prompt_contract_instructions


class PromptDesignTests(unittest.TestCase):
    def test_contract_exposes_stable_character_and_scene_sections(self) -> None:
        contract = prompt_contract()
        self.assertEqual(contract["version"], PROMPT_CONTRACT_VERSION)
        self.assertIn("character", contract["class_requirements"])
        self.assertIn("scene", contract["class_requirements"])
        self.assertEqual(contract["prompt_pack_shape"]["schemaVersion"], PROMPT_CONTRACT_VERSION)
        instructions = prompt_contract_instructions()
        self.assertIn("identityAnchor", instructions)
        self.assertIn("characterDetails", instructions)
        self.assertIn("sceneDetails", instructions)
        self.assertIn("shotPlan", instructions)

    def test_prompt_separates_image_generation_reference_asset_ids(self) -> None:
        prompt = build_natural_language_prompt(
            "prop",
            {
                "promptIntent": "锁定 P10 的机械结构",
                "referenceRoles": [{"referenceId": "P02", "role": "connected_character"}],
                "identityAnchor": "P10 是围绕 P02 的六翼机械道具",
            },
        )
        self.assertIn("图片生成时需要提供的参考图资产：P02", prompt)

    def test_character_coverage_accepts_legacy_aliases_and_reports_missing_detail(self) -> None:
        quality = assess_prompt_pack(
            "character",
            {
                "identity": "成年女性黑甲忍者",
                "faceExpression": "锐利眉眼，冷峻表情",
                "hairSilhouette": "高束长发，侧发丝",
                "wardrobeMaterial": "哑光分层装甲",
                "poseAction": "低重心移动",
                "camera": "中近景",
                "lighting": "蓝紫边缘光",
                "continuity": "左侧站位与武器位置不变",
                "mustAvoid": ["多余肢体"],
            },
        )
        self.assertEqual(quality["status"], "needs-detail")
        self.assertGreaterEqual(quality["coverage"]["passed"], 8)
        self.assertIn("参考板策略", quality["missing"])

    def test_scene_coverage_uses_explicit_scene_detail_sections(self) -> None:
        quality = assess_prompt_pack(
            "scene",
            {
                "identityAnchor": "同一座雨后高架平台",
                "sceneDetails": {
                    "locationAndFunction": "建立世界观的高空平台",
                    "geography": {"foreground": "破损护栏", "midground": "开阔动作区", "background": "摩天楼"},
                    "propsAndSetDressing": ["护栏", "浅积水"],
                    "surfacesAndMaterials": "湿润黑色合金，细密划痕",
                    "lightingAndAtmosphere": "蓝紫霓虹、雨后冷雾、左向右强风",
                    "actionSpace": "中央无障碍，后段可追踪水纹",
                    "continuityAnchors": ["护栏缺口位置", "风向"],
                },
                "shotPlan": [{"shotId": "S01", "framing": "大全景", "camera": "低机位", "focus": "平台"}],
                "visualStyle": {"medium": "电影级写实"},
                "continuityChecklist": ["地标不漂移"],
                "negativePrompt": ["无可读文字"],
            },
        )
        self.assertEqual(quality["status"], "ready")
        self.assertEqual(quality["coverage"]["percent"], 100)

    def test_audio_prompt_uses_minimax_web_fields_and_blocks_unconfirmed_text(self) -> None:
        pack = {
            "promptIntent": "为 P01 建立一条 MiniMax Speech 2.8 Web 试听",
            "identityAnchor": "P01 的成年女性低沉中文声音",
            "audioDetails": {
                "sourceText": "看招。",
                "textStatus": "candidate",
                "voiceIdentity": "成年女性中文普通话，低沉、冷峻、近距离",
                "performanceDirection": "咬字清楚，句尾收住，保留短停顿",
                "language": "中文",
                "dialect": "普通话",
                "emotion": "calm",
                "pace": "略慢",
            },
            "continuityChecklist": ["与口型同步"],
            "mustAvoid": ["环境声覆盖辅音"],
        }
        prompt = build_natural_language_prompt("audio", pack)
        package = build_audio_prompt_package(pack, context={"shots": [{"id": "S03", "dialogue": "看招。"}, {"id": "S16"}]})
        self.assertEqual(package["schemaVersion"], AUDIO_PROMPT_SCHEMA_VERSION)
        self.assertEqual(package["textStatus"], "candidate")
        self.assertEqual(package["copyText"], "")
        self.assertEqual(package["candidateText"], "看招。")
        self.assertIn("候选朗读文本待用户确认", prompt)
        self.assertNotIn("空间关系与地理", prompt)
        self.assertNotIn("FRAMEFLOW", prompt)

    def test_audio_prompt_exposes_only_confirmed_text_as_copy_text(self) -> None:
        package = build_audio_prompt_package({
            "audioDetails": {
                "sourceText": "看招。<#0.35#>",
                "textStatus": "confirmed",
                "model": "speech-2.8-hd",
                "languageBoost": "Chinese",
            },
        })
        self.assertEqual(package["copyText"], "看招。<#0.35#>")
        self.assertEqual(package["candidateText"], "")

    def test_audio_prompt_v2_keeps_provider_text_and_derives_japanese_boost(self) -> None:
        package = build_audio_prompt_package({
            "audioDetails": {
                "sourceText": "先輩、今日の放課後、一緒に帰りませんか？",
                "providerText": "先輩、今日の放課後、(breath) 一緒に帰りませんか？",
                "textStatus": "confirmed",
                "locale": "ja-JP",
                "language": "Japanese",
                "providerVoiceId": "Japanese_SportyStudent",
                "providerRegion": "cn",
            },
        })
        self.assertEqual(package["schemaVersion"], "minimax-speech-audio-v2")
        self.assertNotIn("(breath)", package["sourceText"])
        self.assertIn("(breath)", package["providerText"])
        self.assertEqual(package["copyText"], package["providerText"])
        self.assertEqual(package["settings"]["languageBoost"], "Japanese")

    def test_audio_quality_does_not_count_pending_status_as_spoken_text(self) -> None:
        quality = assess_prompt_pack("audio", {"identityAnchor": "P01 的成年女性中文声音"}, "MiniMax Speech 2.8 Web：尚未确认唯一朗读文本，暂不生成。")
        self.assertIn("朗读文本", quality["missing"])


if __name__ == "__main__":
    unittest.main()
