from __future__ import annotations

import unittest

from frameflow.prompt_design import PROMPT_CONTRACT_VERSION, assess_prompt_pack, build_natural_language_prompt, prompt_contract, prompt_contract_instructions


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

    def test_compiled_prompt_is_idempotent_when_persisted_as_fallback(self) -> None:
        pack = {"promptIntent": "建立可复用的声音身份参考", "identityAnchor": "P01 的成年女性低沉中文声音"}
        first = build_natural_language_prompt("audio", pack, "等待用户确认台词和录音方式。")
        second = build_natural_language_prompt("audio", pack, first)
        self.assertEqual(second, first)
        self.assertEqual(second.count("同时满足以下补充制作要求："), 1)


if __name__ == "__main__":
    unittest.main()
