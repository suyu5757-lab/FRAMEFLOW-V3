from __future__ import annotations

import unittest

from frameflow.prompt_design import AUDIO_PROMPT_SCHEMA_VERSION, PROMPT_CONTRACT_VERSION, assess_prompt_pack, build_audio_prompt_package, build_natural_language_prompt, prompt_contract, prompt_contract_instructions, validate_clean_prompt


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

    def test_clean_replace_does_not_append_previous_or_supplement_text(self) -> None:
        pack = {
            "promptIntent": "建立一座可复用的雨夜祠堂场景",
            "identityAnchor": "同一座湘西乡村祠堂",
            "visibleEvent": "雨水在湿石阶上形成连续反射",
            "cameraExecution": {"framing": "中远景", "camera": "平视固定机位", "focus": "祠堂入口"},
            "visualStyle": {"medium": "写实场景设计参考", "lighting": "冷暖克制"},
            "sceneDetails": {
                "identityAndPurpose": "建立关系的乡村祠堂",
                "spatialLayoutAndGeography": "前景湿石阶，中景空院落，背景木门与檐下暖灯",
                "materialsAndSurfaceState": "吸水石材和旧木表面有细密雨水膜",
                "lightingWeatherAtmosphere": "冷蓝雨夜环境光与檐下暖光形成可见反射",
            },
            "continuityChecklist": ["木门位置和暖灯方向保持不变"],
            "mustAvoid": ["不新增建筑", "不出现可读文字"],
        }
        prompt = build_natural_language_prompt(
            "scene",
            pack,
            "旧 Prompt 的完整正文。\n\n同时满足以下补充制作要求：新的用户输入。",
            composition_mode="clean_replace",
        )
        self.assertIn("雨水在湿石阶上形成连续反射", prompt)
        self.assertNotIn("旧 Prompt 的完整正文", prompt)
        self.assertNotIn("同时满足以下补充制作要求", prompt)

    def test_clean_prompt_validation_rejects_internal_markers_and_old_prefix(self) -> None:
        previous = "旧 Prompt 的完整正文。" * 20
        issues = validate_clean_prompt(
            f"{previous}\n\nFRAMEFLOW Prompt Contract v2.0\n\n新要求。",
            previous,
        )
        self.assertTrue(any("内部标记" in issue for issue in issues))
        self.assertTrue(any("旧 Prompt 全文开头" in issue for issue in issues))
        conflict_issues = validate_clean_prompt("静态结构参考板使用无动作姿态，但角色抬眼并触碰机甲。")
        self.assertTrue(any("镜头级机甲动作" in issue for issue in conflict_issues))

    def test_base_character_compiler_emits_one_static_turnaround_without_metadata_or_shot_actions(self) -> None:
        prompt = build_natural_language_prompt(
            "character",
            {
                "promptIntent": "建立可跨镜头复用的角色基础身份参考板",
                "identityAnchor": "C001 是 20–22 岁视觉年龄的东亚成年年轻女性驾驶员",
                "visibleEvent": "同一张合成参考板静态展示同一角色的四个视图",
                "cameraExecution": {"framing": "结构参考板", "camera": "中性设计记录视角", "focus": "眼睛、发际线和手部"},
                "visualStyle": {"medium": "真人可信的写实角色设计参考", "palette": "冷白、石墨黑"},
                "characterDetails": {
                    "faceAndExpression": "窄鹅蛋脸、柔和下颌、深棕近黑杏仁眼、轻微眼睑不对称、少量可见毛孔，表情自然放松",
                    "hairAndHeadSilhouette": "黑色偏冷棕中短层次发，前侧贴脸，后侧固定为低位短束发，前侧、侧面和背面长度一致",
                    "bodyPoseAction": "纤细修长的运动型成年女性比例，双手自然可见的中性站姿，不接触机甲、不执行出击动作",
                    "costumeAndMaterials": "冷白驾驶服、石墨黑固定结构、白色驾驶手套和双腕青蓝同步接口",
                    "detailAndMaterialBehavior": "中性棚灯同时显示皮肤纹理、发丝边缘、织物缝线、磨砂装甲和手套的材质差异",
                },
                "continuityChecklist": ["SH001 与 SH002 复用同一张脸和服装结构"],
                "mustPreserve": ["C001 原始资产 ID", "白色驾驶手套"],
                "mustAvoid": ["重复角色", "文字和水印"],
            },
            "旧 Prompt 全文。\n\n同时满足以下补充制作要求：触碰机甲并说‘走吧。’",
            composition_mode="base_asset",
        )
        self.assertIn("38%", prompt)
        self.assertIn("62%", prompt)
        self.assertIn("严格 90° 左侧面全身", prompt)
        self.assertIn("严格 180° 背面全身", prompt)
        self.assertIn("16:9 横向角色设定参考板", prompt)
        self.assertEqual(prompt.count("画布与基础资产输出要求："), 1)
        self.assertIn("不是四名相似角色", prompt)
        self.assertIn("黑色偏冷棕中短层次发", prompt)
        self.assertNotIn("C001", prompt)
        self.assertNotIn("SH001", prompt)
        self.assertNotIn("触碰机甲并说", prompt)
        self.assertNotIn("同时满足以下补充制作要求", prompt)
        self.assertNotIn("允许变化：", prompt)
        self.assertNotIn("Prompt Contract", prompt)

    def test_base_scene_and_prop_compilers_keep_independent_assets_separate_from_fusion(self) -> None:
        scene_prompt = build_natural_language_prompt(
            "scene",
            {
                "promptIntent": "建立可跨镜头复用的空环境",
                "identityAnchor": "同一座雨夜山腰祠堂",
                "visibleEvent": "角色进入画面并在门前放置道具",
                "sceneDetails": {
                    "identityAndPurpose": "承担建立空间关系的乡村祠堂",
                    "spatialLayoutAndGeography": "前景湿石阶，中景空院落，背景木门和檐下灯",
                    "foregroundMidgroundBackground": {"foreground": "湿石阶", "midground": "空院落", "background": "木门"},
                    "setDressingAndFixedAnchors": "左侧铜钟、右侧木门、檐下暖灯位置固定",
                    "materialsAndSurfaceState": "吸水石材和旧木有连续雨水膜",
                    "lightingWeatherAtmosphere": "冷蓝雨夜环境光与檐下暖灯形成反射",
                    "actionBlockingZones": "院落中央保持空白可用",
                    "propPlacementZones": "门前台阶保留空的放置区",
                },
                "continuityChecklist": ["SH003 的固定地标不漂移"],
                "mustAvoid": ["角色进入画面", "道具融合"],
            },
            composition_mode="base_asset",
        )
        prop_prompt = build_natural_language_prompt(
            "prop",
            {
                "promptIntent": "建立独立机械道具设计资产",
                "identityAnchor": "一件可重复使用的六翼机械道具",
                "propDetails": {
                    "objectIdentity": "六翼折叠机械道具，用于稳定光学信号",
                    "silhouetteAndProportions": "六个对称翼片围绕短圆柱核心，左右轮廓平衡",
                    "structureAndFunction": "中心锁扣、六个铰链和一圈窄型接口清晰可见",
                    "materialAndCondition": "磨砂钛灰外壳、黑色橡胶接缝、轻微使用划痕",
                    "colorMarkingsAndLabelPolicy": "石墨黑与少量青蓝状态指示，不出现可读标记",
                    "scaleAndInteraction": "尺度以成年手掌和桌面为文字参照，保留未来握持接触点",
                },
                "mustAvoid": ["人物手部", "场景融合", "Logo"],
            },
            composition_mode="base_asset",
        )
        self.assertIn("动作/阻挡区只保留为空的可用空间", scene_prompt)
        self.assertIn("16:9 横向空环境设计参考图", scene_prompt)
        self.assertIn("背景边界必须展示实际环境的后景层", scene_prompt)
        self.assertNotIn("环境的静态表面/天气状态为：角色进入画面", scene_prompt)
        self.assertNotIn("环境的静态表面/天气状态为：角色进入画面并在门前放置道具", scene_prompt)
        self.assertNotIn("不能用白色、米白或浅灰设计板替代环境本体", prop_prompt)
        self.assertIn("不出现角色、手部、独立道具", scene_prompt)
        self.assertNotIn("SH003", scene_prompt)
        self.assertIn("六翼折叠机械道具", prop_prompt)
        self.assertIn("1:1 正方形独立物品设计参考图", prop_prompt)
        self.assertIn("只生成独立物品设计资产", prop_prompt)
        self.assertIn("不执行手持、穿戴、放置", prop_prompt)

    def test_fusion_is_pinned_to_the_legacy_compiler_when_base_mode_is_requested(self) -> None:
        prompt = build_natural_language_prompt(
            "fusion",
            {
                "promptIntent": "将已确认资产按镜头关系融合",
                "identityAnchor": "已确认角色、道具和环境身份",
                "visibleEvent": "角色握住道具并进入环境",
                "fusionDetails": {"interactionAndContact": "手部接触和地面接触可信"},
            },
            "旧融合 Prompt",
            composition_mode="base_asset",
        )
        self.assertIn("同时满足以下补充制作要求", prompt)
        self.assertIn("旧融合 Prompt", prompt)

    def test_contract_exposes_base_compiler_but_not_for_fusion(self) -> None:
        character_contract = prompt_contract("character")
        self.assertEqual(character_contract["base_asset_compiler"]["version"], "base-asset-v1")
        self.assertIn("validation_contract", character_contract)
        self.assertNotIn("base_asset_compiler", prompt_contract("fusion"))

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
