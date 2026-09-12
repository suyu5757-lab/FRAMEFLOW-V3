from __future__ import annotations

import base64
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def board_project() -> dict:
    assets = [
        {"id": "CHAR_01", "name": "陈继业", "skill": "character", "assetClass": "character", "grade": "B", "prompt": "角色正面设定"},
        {"id": "SCENE_01", "name": "祠堂", "skill": "scene", "assetClass": "scene", "grade": "B"},
        {"id": "PROP_01", "name": "百物录", "skill": "prop", "assetClass": "prop", "grade": "B"},
        {"id": "FUSION_01", "name": "祠堂夜戏融合", "skill": "fusion", "assetClass": "fusion", "grade": "B", "fusionSourceAssetIds": ["CHAR_01", "SCENE_01", "PROP_01"]},
    ]
    shots = [
        {"id": "S001", "scene": "祠堂", "duration": 4, "assetRequirements": [{"assetId": "CHAR_01", "assetClass": "character"}, {"assetId": "SCENE_01", "assetClass": "scene"}]},
        {"id": "S002", "scene": "祠堂", "duration": 5, "assetRequirements": [{"assetId": "PROP_01", "assetClass": "prop"}]},
    ]
    return {
        "id": "PRJ_BOARD", "name": "资产画布测试", "ratio": "16:9", "duration": 9,
        "generator": "manual", "brief": "资产生产工作台测试", "stage": 0, "sortOrder": 0,
        "script": "", "assets": assets, "shots": shots, "audio": {}, "assetRegulator": {},
        "generations": [], "seedancePackages": [], "providerOverrides": {}, "undoStack": [],
        "scriptVersions": [], "storyboardVersions": [], "storyWorkflowRuns": [],
    }


class AssetBoardV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-asset-board-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_BOARD", json={"document": board_project()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_first_open_builds_independent_board_and_sync_preserves_positions(self) -> None:
        first = self.client.get("/api/v2/projects/PRJ_BOARD/asset-board")
        self.assertEqual(first.status_code, 200, first.text)
        payload = first.json()
        self.assertEqual(payload["revision"], 1)
        self.assertEqual(len([node for node in payload["board"]["nodes"] if node["node_type"] == "shot"]), 2)
        self.assertEqual(len([node for node in payload["board"]["nodes"] if node["node_type"] == "asset"]), 4)
        self.assertTrue(any(edge["relation"] == "shot_dependency" for edge in payload["board"]["edges"]))
        self.assertTrue(any(edge["relation"] == "fusion_input" for edge in payload["board"]["edges"]))

        board = payload["board"]
        asset_node = next(node for node in board["nodes"] if node["id"] == "asset:CHAR_01")
        asset_node["position"] = {"x": 991, "y": 337}
        saved = self.client.put("/api/v2/projects/PRJ_BOARD/asset-board", json={"board": board, "expected_revision": 1})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 2)
        self.assertTrue(any(edge["relation"] == "shot_dependency" for edge in saved.json()["board"]["edges"]))

        synced = self.client.post("/api/v2/projects/PRJ_BOARD/asset-board/sync", json={"expected_revision": 2, "preserve_layout": True})
        self.assertEqual(synced.status_code, 200, synced.text)
        self.assertEqual(next(node for node in synced.json()["board"]["nodes"] if node["id"] == "asset:CHAR_01")["position"], {"x": 991.0, "y": 337.0})

    def test_asset_intent_is_per_asset_and_hides_normalized_ai_details(self) -> None:
        initial = self.client.get("/api/v2/projects/PRJ_BOARD/asset-intents")
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["progress"], {"handled": 0, "total": 3, "percent": 0, "allHandled": False})
        self.assertEqual({asset["assetId"] for asset in initial.json()["assets"]}, {"CHAR_01", "SCENE_01", "PROP_01"})
        fusion_plan = next(plan for plan in initial.json()["systemPlans"] if plan["assetId"] == "FUSION_01")
        self.assertEqual(fusion_plan["kind"], "fusion")
        self.assertEqual(fusion_plan["status"], "system_planned")

        interpretation = {
            "assetId": "CHAR_01",
            "assetClass": "character",
            "normalizedIntent": {
                "summary": "沉稳的角色身份",
                "stableAnchors": ["深色短发"],
                "userAdjustments": ["增加专业感"],
                "shotSpecificDetails": [],
                "mustPreserve": ["角色身份"],
                "mustAvoid": ["动漫化比例"],
                "unmatchedMentions": [],
            },
            "warnings": [],
            "unmatchedMentions": [],
        }
        with mock.patch.object(server, "_run_asset_intent_agent", new=mock.AsyncMock(return_value=interpretation)):
            submitted = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/CHAR_01/interpret", json={
                "expected_revision": 1,
                "user_text": "保留深色短发，整体更专业沉稳。",
                "mode": "user_input",
            })
        self.assertEqual(submitted.status_code, 200, submitted.text)
        payload = submitted.json()
        character = next(asset for asset in payload["assets"] if asset["assetId"] == "CHAR_01")
        self.assertEqual(character["status"], "submitted")
        self.assertEqual(character["mode"], "user_input")
        self.assertEqual(character["userText"], "保留深色短发，整体更专业沉稳。")
        self.assertNotIn("normalizedIntent", character)

        script_only = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/SCENE_01/interpret", json={
            "expected_revision": payload["revision"],
            "mode": "script_only",
        })
        self.assertEqual(script_only.status_code, 200, script_only.text)
        self.assertEqual(script_only.json()["progress"]["handled"], 2)

        deferred = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/PROP_01/interpret", json={
            "expected_revision": script_only.json()["revision"],
            "mode": "deferred",
        })
        self.assertEqual(deferred.status_code, 200, deferred.text)
        self.assertTrue(deferred.json()["progress"]["allHandled"])
        self.assertEqual({asset["assetId"] for asset in deferred.json()["assets"]}, {"CHAR_01", "SCENE_01", "PROP_01"})

        project = self.client.get("/api/v2/projects/PRJ_BOARD").json()["document"]
        self.assertEqual({asset["id"] for asset in project["assets"]}, {"CHAR_01", "SCENE_01", "PROP_01", "FUSION_01"})
        self.assertNotIn("assetPromptRuns", project)

    def test_asset_intent_separates_fusion_shot_continuity_and_audio_plans(self) -> None:
        document = board_project()
        document["id"] = "PRJ_INTENT_LAYERS"
        document["assets"].extend([
            {"id": "SH01_TAIL", "name": "SH01 尾帧首帧连续性", "skill": "fusion", "assetClass": "fusion", "assetRole": "shot_reference", "grade": "A"},
            {"id": "A01_AMBIENCE", "name": "机库低频环境声", "skill": "audio", "assetClass": "audio", "assetRole": "ambience", "grade": "A"},
        ])
        created = self.client.put("/api/v2/projects/PRJ_INTENT_LAYERS", json={"document": document})
        self.assertEqual(created.status_code, 200, created.text)

        envelope = self.client.get("/api/v2/projects/PRJ_INTENT_LAYERS/asset-intents")
        self.assertEqual(envelope.status_code, 200, envelope.text)
        payload = envelope.json()
        self.assertEqual({asset["assetId"] for asset in payload["assets"]}, {"CHAR_01", "SCENE_01", "PROP_01"})
        self.assertEqual(payload["progress"]["total"], 3)
        plans = {plan["assetId"]: plan for plan in payload["systemPlans"]}
        self.assertEqual(set(plans), {"FUSION_01", "SH01_TAIL", "A01_AMBIENCE"})
        self.assertEqual(plans["FUSION_01"]["kind"], "fusion")
        self.assertEqual(plans["SH01_TAIL"]["kind"], "shot_continuity")
        self.assertEqual(plans["A01_AMBIENCE"]["kind"], "audio")

        for asset_id in plans:
            rejected = self.client.post(f"/api/v2/projects/PRJ_INTENT_LAYERS/asset-intents/{asset_id}/interpret", json={"expected_revision": payload["revision"], "mode": "script_only"})
            self.assertEqual(rejected.status_code, 409, rejected.text)
            self.assertIn("系统自动处理", rejected.json()["detail"])

    def test_asset_prompt_generation_rejects_incomplete_confirmed_intent_version(self) -> None:
        response = self.client.post("/api/v2/projects/PRJ_BOARD/asset-prompt-runs", json={
            "expected_revision": 1,
            "asset_intent_version": 0,
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("未明确处理", response.json()["message"])

    def test_asset_intent_preparation_materializes_existing_story_handoff_without_prompt_generation(self) -> None:
        document = board_project()
        document["id"] = "PRJ_PREPARE"
        document["assets"] = []
        created = self.client.put("/api/v2/projects/PRJ_PREPARE", json={"document": document})
        self.assertEqual(created.status_code, 200, created.text)

        initial = self.client.get("/api/v2/projects/PRJ_PREPARE/asset-intents")
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertFalse(initial.json()["assetManifestReady"])
        self.assertEqual(initial.json()["progress"]["total"], 0)

        prepared = self.client.post("/api/v2/projects/PRJ_PREPARE/asset-intents/prepare", json={
            "expected_revision": initial.json()["revision"],
        })
        self.assertEqual(prepared.status_code, 200, prepared.text)
        payload = prepared.json()
        self.assertEqual(payload["preparedAssetCount"], 3)
        self.assertEqual({asset["assetId"] for asset in payload["assets"]}, {"CHAR_01", "SCENE_01", "PROP_01"})
        self.assertEqual(payload["progress"]["total"], 3)
        self.assertFalse(payload["progress"]["allHandled"])
        self.assertNotIn("assetPromptRuns", self.client.get("/api/v2/projects/PRJ_PREPARE").json()["document"])

        board = self.client.get("/api/v2/projects/PRJ_PREPARE/asset-board")
        self.assertEqual(board.status_code, 200, board.text)
        self.assertEqual(len([node for node in board.json()["board"]["nodes"] if node["node_type"] == "asset"]), 3)

    def test_story_content_change_invalidates_asset_intent_even_without_new_storyboard_version(self) -> None:
        current = self.client.get("/api/v2/projects/PRJ_BOARD/asset-intents").json()
        for asset_id in ("CHAR_01", "SCENE_01", "PROP_01"):
            response = self.client.post(f"/api/v2/projects/PRJ_BOARD/asset-intents/{asset_id}/interpret", json={
                "expected_revision": current["revision"],
                "mode": "script_only",
            })
            self.assertEqual(response.status_code, 200, response.text)
            current = response.json()
        story = self.client.get("/api/v2/projects/PRJ_BOARD/story").json()
        story_document = story["story"]
        story_document["spec"]["creative_goal"] = "修改后的故事目标"
        saved = self.client.put("/api/v2/projects/PRJ_BOARD/story", json={
            "expected_revision": current["revision"],
            "spec": story_document["spec"],
            "script": story_document["script"],
            "scenes": story_document["scenes"],
            "shots": story_document["shots"],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        stale = self.client.get("/api/v2/projects/PRJ_BOARD/asset-intents")
        self.assertEqual(stale.status_code, 200, stale.text)
        self.assertTrue(stale.json()["manifestStale"])
        self.assertTrue(any("故事或分镜" in warning for warning in stale.json()["warnings"]))

        rebased = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/rebase", json={
            "expected_revision": stale.json()["revision"],
        })
        self.assertEqual(rebased.status_code, 200, rebased.text)
        self.assertFalse(rebased.json()["manifestStale"])
        self.assertEqual(rebased.json()["progress"]["handled"], 0)
        self.assertEqual(next(asset for asset in rebased.json()["assets"] if asset["assetId"] == "CHAR_01")["userText"], "")

    def test_confirmed_asset_intents_are_passed_to_the_existing_prompt_pipeline(self) -> None:
        intent_result = {
            "assetId": "CHAR_01", "assetClass": "character",
            "normalizedIntent": {"summary": "稳定的角色身份", "stableAnchors": ["深色短发"], "userAdjustments": ["更专业"], "shotSpecificDetails": [], "mustPreserve": ["角色身份"], "mustAvoid": [], "unmatchedMentions": []},
            "warnings": [], "unmatchedMentions": [],
        }
        with mock.patch.object(server, "_run_asset_intent_agent", new=mock.AsyncMock(return_value=intent_result)):
            character = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/CHAR_01/interpret", json={"expected_revision": 1, "user_text": "深色短发，更专业稳定。", "mode": "user_input"})
        self.assertEqual(character.status_code, 200, character.text)
        current_revision = character.json()["revision"]
        scene = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/SCENE_01/interpret", json={"expected_revision": current_revision, "mode": "script_only"})
        self.assertEqual(scene.status_code, 200, scene.text)
        current_revision = scene.json()["revision"]
        prop = self.client.post("/api/v2/projects/PRJ_BOARD/asset-intents/PROP_01/interpret", json={"expected_revision": current_revision, "mode": "deferred"})
        self.assertEqual(prop.status_code, 200, prop.text)
        intent_version = prop.json()["assetIntentVersion"]

        def pack(asset_class: str) -> dict:
            return {
                "promptIntent": f"{asset_class} 的生产设定",
                "identityAnchor": f"稳定的 {asset_class} 身份",
                "visibleEvent": "在镜头中保持可识别状态",
                "cameraExecution": {"framing": "中景", "camera": "固定机位", "focus": "主体"},
                "visualStyle": {"medium": "写实制作参考", "lighting": "克制"},
                "characterDetails": {}, "sceneDetails": {}, "propDetails": {}, "fusionDetails": {},
                "continuityChecklist": [], "mustAvoid": [],
            }

        regulator = {
            "assetExtraction": [
                {"id": "CHAR_01", "name": "陈继业", "assetClass": "character", "grade": "B"},
                {"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "grade": "B"},
                {"id": "PROP_01", "name": "百物录", "assetClass": "prop", "grade": "B"},
            ],
            "assetRequirements": [
                {"shotId": "S001", "assetId": "CHAR_01", "assetClass": "character", "required": True},
                {"shotId": "S001", "assetId": "SCENE_01", "assetClass": "scene", "required": True},
                {"shotId": "S002", "assetId": "PROP_01", "assetClass": "prop", "required": True},
            ],
        }
        prompt_output = {
            "assets": [
                {"id": "CHAR_01", "name": "陈继业", "assetClass": "character", "priority": "B", "required": True, "targetSkill": "video-character-design-director", "relevantShots": ["S001"], "prompt": "角色 Prompt", "promptPack": pack("角色"), "mustPreserve": [], "mustAvoid": [], "imageGenerationEligible": True},
                {"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "priority": "B", "required": True, "targetSkill": "video-scene-design-director", "relevantShots": ["S001"], "prompt": "环境 Prompt", "promptPack": pack("环境"), "mustPreserve": [], "mustAvoid": [], "imageGenerationEligible": True},
                {"id": "PROP_01", "name": "百物录", "assetClass": "prop", "priority": "B", "required": True, "targetSkill": "video-prop-design-director", "relevantShots": ["S002"], "prompt": "道具 Prompt", "promptPack": pack("道具"), "mustPreserve": [], "mustAvoid": [], "imageGenerationEligible": True},
            ],
            "fusionPlans": [], "missingAssetRegister": [], "dependencyTable": [], "routingPlan": [], "nextActions": [], "warnings": [],
        }
        captured: dict[str, dict] = {}

        async def fake_regulator(request, project_id, input_package):
            captured["regulator"] = input_package
            return regulator

        async def fake_prompt(request, project_id, input_package):
            captured["prompt"] = input_package
            return prompt_output

        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(side_effect=fake_regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(side_effect=fake_prompt)):
            generated = self.client.post("/api/v2/projects/PRJ_BOARD/asset-prompt-runs", json={"expected_revision": prop.json()["revision"], "asset_intent_version": intent_version})
        self.assertEqual(generated.status_code, 200, generated.text)
        self.assertEqual({item["assetId"] for item in captured["prompt"]["confirmed_asset_intents"]}, {"CHAR_01", "SCENE_01", "PROP_01"})
        character_intent = next(item for item in captured["prompt"]["confirmed_asset_intents"] if item["assetId"] == "CHAR_01")
        self.assertEqual(character_intent["userText"], "深色短发，更专业稳定。")
        self.assertEqual(character_intent["normalizedIntent"]["summary"], "稳定的角色身份")
        geometry = {item["assetId"]: item for item in captured["prompt"]["asset_generation_policy"]["targets"]}
        self.assertEqual(captured["prompt"]["asset_generation_policy"]["projectOutputAspectRatio"], "16:9")
        self.assertEqual(geometry["CHAR_01"]["aspectRatio"], "16:9")
        self.assertEqual(geometry["SCENE_01"]["aspectRatio"], "16:9")
        self.assertEqual(geometry["PROP_01"]["aspectRatio"], "1:1")
        library = {item["id"]: item for item in generated.json()["library"]["assets"]}
        self.assertEqual(library["CHAR_01"].get("promptCompositionMode"), "base_asset")
        self.assertEqual(library["SCENE_01"].get("promptCompositionMode"), "base_asset")
        self.assertEqual(library["PROP_01"].get("promptCompositionMode"), "base_asset")
        self.assertNotEqual(library["FUSION_01"].get("promptCompositionMode"), "base_asset")
        self.assertEqual(generated.json()["run"]["assetIntentVersion"], intent_version)

    def test_production_draft_metadata_builds_empty_prompt_card(self) -> None:
        saved = self.client.patch(
            "/api/v2/projects/PRJ_BOARD/assets/SCENE_01",
            json={"expected_revision": 1, "metadata": {"production_draft": {"active": True, "focus": "upload", "updated_at": "2026-08-22T00:00:00Z"}}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        board = self.client.get("/api/v2/projects/PRJ_BOARD/asset-board")
        self.assertEqual(board.status_code, 200, board.text)
        draft = next(node for node in board.json()["board"]["nodes"] if node["id"] == "handoff:SCENE_01")
        self.assertTrue(draft["config"]["prompt_card"])
        self.assertTrue(draft["config"]["production_draft"])
        self.assertEqual(draft["config"]["prompt"], "")

    def test_targeted_prompt_generation_returns_editor_draft_without_saving_prompt(self) -> None:
        regulator = {
            "assetExtraction": [{"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "grade": "B"}],
            "assetRequirements": [{"shotId": "S001", "assetId": "SCENE_01", "assetClass": "scene", "required": True}],
        }
        prompt_output = {
            "assets": [{"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "prompt": "雨夜祠堂的完整场景 Prompt", "promptPack": {
                "promptIntent": "建立可跨镜头复用的雨夜祠堂场景",
                "identityAnchor": "同一座湘西乡村祠堂",
                "visibleEvent": "雨水在湿石阶上形成连续反射",
                "cameraExecution": {"framing": "中远景", "camera": "平视固定机位", "focus": "祠堂入口"},
                "visualStyle": {"medium": "写实场景设计参考", "lighting": "冷暖克制"},
                "sceneDetails": {
                    "identityAndPurpose": "建立关系的乡村祠堂",
                    "spatialLayoutAndGeography": "前景湿石阶，中景空院落，背景木门与檐下暖灯",
                    "materialsAndSurfaceState": "吸水石材表面有细密雨水膜",
                    "lightingWeatherAtmosphere": "冷蓝雨夜环境光与檐下暖光形成可见反射",
                },
                "continuityChecklist": ["木门位置和暖灯方向保持不变"],
                "mustAvoid": ["不新增建筑", "不出现可读文字"],
            }, "relevantShots": ["S001"]}],
            "fusionPlans": [],
        }
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=prompt_output)):
            response = self.client.post("/api/v2/projects/PRJ_BOARD/asset-prompt-runs", json={"expected_revision": 1, "target_asset_id": "SCENE_01"})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIn("雨水在湿石阶上形成连续反射", payload["run"]["promptCards"][0]["prompt"])
        self.assertEqual(payload["run"]["promptCards"][0]["promptContractVersion"], "2.0")
        self.assertEqual(payload["run"]["promptCards"][0]["promptWorkflow"], "suyu-skill-v2")
        scene = next(asset for asset in payload["library"]["assets"] if asset["id"] == "SCENE_01")
        self.assertEqual(scene.get("prompt", ""), "")
        character = next(asset for asset in payload["library"]["assets"] if asset["id"] == "CHAR_01")
        self.assertEqual(character.get("prompt"), "角色正面设定")

    def test_targeted_prompt_generation_passes_operator_idea_to_both_ai_stages(self) -> None:
        regulator = {
            "assetExtraction": [{"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "grade": "B"}],
            "assetRequirements": [{"shotId": "S001", "assetId": "SCENE_01", "assetClass": "scene", "required": True}],
        }
        prompt_output = {
            "assets": [{"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "prompt": "压低雨水反射后的祠堂场景 Prompt", "promptPack": {
                "promptIntent": "建立一座可跨镜头复用的雨夜祠堂场景",
                "visibleEvent": "雨水在湿石阶上形成连续反射",
                "cameraExecution": {"framing": "中远景", "camera": "平视固定机位", "focus": "祠堂入口"},
                "visualStyle": {"medium": "写实场景设计参考", "lighting": "冷暖克制"},
                "sceneDetails": {
                    "identityAndPurpose": "湘西乡村祠堂，承担建立空间关系的功能",
                    "spatialLayoutAndGeography": "前景湿石阶，中景空院落，背景木门与檐下灯",
                    "materialsAndSurfaceState": "吸水石材和旧木表面有细密雨水膜",
                    "lightingWeatherAtmosphere": "冷蓝雨夜环境光与檐下暖光形成可见反射",
                },
                "continuityChecklist": ["木门位置和檐下暖灯方向保持不变"],
                "mustAvoid": ["不新增建筑", "不出现可读文字"],
            }, "relevantShots": ["S001"]}],
            "fusionPlans": [],
        }
        captured: dict[str, dict] = {}

        async def fake_regulator(request, project_id, input_package):
            captured["regulator"] = input_package
            return regulator

        async def fake_prompt(request, project_id, input_package):
            captured["prompt"] = input_package
            return prompt_output

        operator_idea = "压低雨水反射，让右侧门缝的暖光更集中，但保持祠堂结构和 S001 连续性不变。"
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(side_effect=fake_regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(side_effect=fake_prompt)):
            response = self.client.post("/api/v2/projects/PRJ_BOARD/asset-prompt-runs", json={"expected_revision": 1, "target_asset_id": "SCENE_01", "operator_idea": operator_idea})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(captured["regulator"]["operator_idea"], operator_idea)
        self.assertEqual(captured["prompt"]["operator_idea"], operator_idea)
        self.assertEqual(captured["prompt"]["target_asset_id"], "SCENE_01")
        self.assertEqual(response.json()["run"]["operatorIdea"], operator_idea)
        generated_prompt = response.json()["run"]["promptCards"][0]["prompt"]
        self.assertIn("雨水在湿石阶上形成连续反射", generated_prompt)
        self.assertNotIn("同时满足以下补充制作要求", generated_prompt)
        scene = next(asset for asset in response.json()["library"]["assets"] if asset["id"] == "SCENE_01")
        self.assertEqual(scene.get("prompt", ""), "")

    def test_clean_prompt_save_replaces_old_pack_without_appending_it(self) -> None:
        def scene_pack(intent: str, surface: str) -> dict:
            return {
                "promptIntent": intent,
                "identityAnchor": "同一座湘西乡村祠堂",
                "visibleEvent": "雨水在湿石阶上形成连续反射",
                "cameraExecution": {"framing": "中远景", "camera": "平视固定机位", "focus": "祠堂入口"},
                "visualStyle": {"medium": "写实场景设计参考", "lighting": "冷暖克制"},
                "sceneDetails": {
                    "identityAndPurpose": "建立关系的乡村祠堂",
                    "spatialLayoutAndGeography": "前景湿石阶，中景空院落，背景木门与檐下暖灯",
                    "materialsAndSurfaceState": surface,
                    "lightingWeatherAtmosphere": "冷蓝雨夜环境光与檐下暖光形成可见反射",
                },
                "continuityChecklist": ["木门位置和暖灯方向保持不变"],
                "mustAvoid": ["不新增建筑", "不出现可读文字"],
            }

        first = self.client.patch("/api/v2/projects/PRJ_BOARD/assets/SCENE_01", json={
            "expected_revision": 1,
            "asset_class": "scene",
            "prompt": "旧版本祠堂 Prompt",
            "prompt_pack": scene_pack("旧版本祠堂设计", "旧石材表面"),
            "source": "asset-library",
        })
        self.assertEqual(first.status_code, 200, first.text)
        second = self.client.patch("/api/v2/projects/PRJ_BOARD/assets/SCENE_01", json={
            "expected_revision": first.json()["revision"],
            "asset_class": "scene",
            "prompt": "全新重写稿，不应与旧稿拼接。",
            "prompt_pack": scene_pack("全新重写的祠堂设计", "新的湿石材表面状态"),
            "source": "asset-prompt-generator",
        })
        self.assertEqual(second.status_code, 200, second.text)
        scene = next(asset for asset in second.json()["library"]["assets"] if asset["id"] == "SCENE_01")
        self.assertIn("全新重写的祠堂设计", scene["prompt"])
        self.assertIn("新的湿石材表面状态", scene["prompt"])
        self.assertNotIn("旧版本祠堂设计", scene["prompt"])
        self.assertNotIn("同时满足以下补充制作要求", scene["prompt"])

    def test_c001_character_rewrite_is_one_clean_sheet_and_moves_shot_actions_out(self) -> None:
        regulator = {
            "assetExtraction": [{"id": "CHAR_01", "name": "C001", "assetClass": "character", "grade": "A"}],
            "assetRequirements": [{"shotId": "S001", "assetId": "CHAR_01", "assetClass": "character", "required": True}],
        }
        prompt_pack = {
            "promptIntent": "建立 C001 可跨 SH001 与 SH002 复用的单张角色结构参考板",
            "identityAnchor": "C001 是 20–22 岁视觉年龄的东亚成年年轻女性机甲驾驶员；白色驾驶服和白色驾驶手套是稳定身份锚点",
            "visibleEvent": "同一张合成参考板静态展示同一角色的面部与上半身特写、正面全身、侧面全身和背面全身视图",
            "cameraExecution": {"framing": "一张合成结构参考板", "camera": "中性设计记录视角，避免广角变形", "focus": "眼睛、发际线、手部和服装接缝", "depthOfField": "特写清晰，全身视图四肢和服装清楚"},
            "visualStyle": {"medium": "真人可信的角色设计参考板", "palette": "白色、米白、浅灰背景，珍珠白与石墨黑装备", "lighting": "稳定均匀的中性棚拍设计光"},
            "characterDetails": {
                "faceAndExpression": "柔和鹅蛋脸，自然清晰的下颌和纤细下巴；杏仁形眼睛，深棕接近黑色虹膜，睫毛明显但自然；明亮干净的东亚年轻女性肤色，保留轻微真实皮肤纹理与自然微不对称；默认表情平静克制",
                "hairAndHeadSilhouette": "黑色偏冷棕的中短发，长度从下巴至肩部，带自然层次；前侧与侧面有少量较长发丝，后脑保留低位小束发，四个视图轮廓一致",
                "bodyPoseAction": "纤细、修长、运动型比例，肩颈自然、腰部纤细、腿部较长；静态结构板使用双手自然可见的平衡中性站姿，不接触机甲、不抬眼、不执行出击动作",
                "costumeAndMaterials": "珍珠白或冷白高性能驾驶服，石墨黑辅助结构；可见锁骨轻型装甲、肩部薄型保护结构、前臂机械接口、青蓝腕部同步装置、腰侧组件、膝部薄型保护结构、颈后连接结构；白色驾驶手套区分柔性织物与较平滑表面",
                "detailAndMaterialBehavior": "中性设计光使眼睛、皮肤微纹理、发丝边缘、服装接缝、薄型装甲和白色手套材质差异可检查；结构板不加入机甲青蓝剧情光或散热气流",
            },
            "continuityChecklist": ["四个视图保持同一张脸、发型轮廓、白色驾驶服、白色驾驶手套、身体比例和手部尺度", "SH001 与 SH002 复用同一套角色身份锚点"],
            "mustPreserve": ["C001 原始资产 ID", "白色驾驶服", "白色驾驶手套", "SH001 与 SH002 连续性"],
            "mustAvoid": ["机甲、机库、剧情道具、青蓝剧情光、重复角色、文字和水印", "把镜头级接触动作写进结构参考板"],
        }
        prompt_output = {
            "assets": [{
                "id": "CHAR_01",
                "name": "C001",
                "assetClass": "character",
                "prompt": "旧 Prompt 全文。\n\n同时满足以下补充制作要求：角色设定原文，包括右手食指触碰机甲机械手指、抬眼、轻微笑意和‘走吧。’",
                "promptPack": prompt_pack,
                "relevantShots": ["S001"],
                "mustPreserve": prompt_pack["mustPreserve"],
                "mustAvoid": prompt_pack["mustAvoid"],
            }],
            "fusionPlans": [],
        }
        operator_idea = (
            "【角色01】20–22 岁成年年轻女性，东亚审美，柔和鹅蛋脸，黑色偏冷棕中短发，"
            "珍珠白驾驶服与白色驾驶手套；右手食指触碰机甲机械手指、启动后抬眼、轻微笑意并说‘走吧。’"
        )
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=prompt_output)):
            response = self.client.post(
                "/api/v2/projects/PRJ_BOARD/asset-prompt-runs",
                json={"expected_revision": 1, "target_asset_id": "CHAR_01", "operator_idea": operator_idea},
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        generated_prompt = payload["run"]["promptCards"][0]["prompt"]
        self.assertIn("静态展示同一角色", generated_prompt)
        self.assertIn("珍珠白或冷白高性能驾驶服", generated_prompt)
        self.assertNotIn("旧 Prompt 全文", generated_prompt)
        self.assertNotIn("同时满足以下补充制作要求", generated_prompt)
        self.assertNotIn("右手食指触碰机甲机械手指", generated_prompt)
        self.assertNotIn("走吧", generated_prompt)
        self.assertEqual(payload["run"]["operatorIdea"], operator_idea)
        self.assertEqual(next(asset for asset in payload["library"]["assets"] if asset["id"] == "CHAR_01").get("prompt"), "角色正面设定")
        self.assertEqual(next(asset for asset in payload["library"]["assets"] if asset["id"] == "CHAR_01").get("promptQaDecision"), None)

    def test_incomplete_target_rewrite_is_rejected_without_new_prompt_version(self) -> None:
        regulator = {
            "assetExtraction": [{"id": "CHAR_01", "name": "C001", "assetClass": "character", "grade": "B"}],
            "assetRequirements": [{"shotId": "S001", "assetId": "CHAR_01", "assetClass": "character", "required": True}],
        }
        incomplete_output = {
            "assets": [{"id": "CHAR_01", "name": "C001", "assetClass": "character", "prompt": "只返回一段新文字，但没有完整 Prompt Pack", "promptPack": {}, "relevantShots": ["S001"]}],
            "fusionPlans": [],
        }
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=incomplete_output)):
            response = self.client.post(
                "/api/v2/projects/PRJ_BOARD/asset-prompt-runs",
                json={"expected_revision": 1, "target_asset_id": "CHAR_01", "operator_idea": "补充一个新的角色想法"},
            )

        self.assertEqual(response.status_code, 502, response.text)
        self.assertIn("完整的 Prompt 替换稿", response.text)
        library = self.client.get("/api/v2/projects/PRJ_BOARD/assets").json()
        character = next(asset for asset in library["assets"] if asset["id"] == "CHAR_01")
        self.assertEqual(character.get("prompt"), "角色正面设定")
        self.assertEqual(character.get("promptVersions"), [])

    def test_provider_component_suffixes_fold_back_into_stable_asset_id(self) -> None:
        repaired = server._repair_prompt_card_ids(
            {
                "assets": [
                    {"id": "P08A", "assetClass": "prop", "name": "P08A 实体手里剑", "prompt": "三枚实体手里剑", "promptPack": {"propDetails": {"objectIdentity": "手里剑"}}, "relevantShots": ["S04"], "mustPreserve": ["三枚实体"], "mustAvoid": []},
                    {"id": "P08B", "assetClass": "vfx", "name": "P08B 复制光轮", "prompt": "蓝紫复制光轮", "promptPack": {"propDetails": {"materialAndCondition": "蓝紫能量边缘"}}, "relevantShots": ["S05"], "mustPreserve": ["复制光轮"], "mustAvoid": ["可数实体堆叠"]},
                ],
                "warnings": [],
            },
            {"P08"},
            {"P08"},
            {"P08": {"id": "P08", "name": "手里剑与复制光轮", "assetClass": "weapon_effect"}},
        )
        self.assertEqual([card["id"] for card in repaired["assets"]], ["P08"])
        card = repaired["assets"][0]
        self.assertEqual(card["assetClass"], "prop")
        self.assertIn("实体手里剑", card["prompt"])
        self.assertIn("复制光轮", card["prompt"])
        self.assertEqual(card["relevantShots"], ["S04", "S05"])
        self.assertEqual(card["mustPreserve"], ["三枚实体", "复制光轮"])
        self.assertEqual(card["mustAvoid"], ["可数实体堆叠"])
        self.assertEqual([item["sourceId"] for item in card["promptPack"]["componentDetails"]], ["P08A", "P08B"])
        self.assertIn("P08A", repaired["warnings"][0])

    def test_regulator_aliases_and_component_requirements_keep_stable_ids(self) -> None:
        normalized = server._normalise_regulator_output(
            {
                "assetExtraction": [{"assetId": "P08", "assetClass": "weapon_effect"}],
                "assetRequirements": [
                    {"shot_id": "S04", "assetId": "P08-OBJ", "assetClass": "prop"},
                    {"shotId": "S05", "assetId": "P03-P05", "assetClass": "prop"},
                ],
            },
            set(),
        )
        self.assertEqual(normalized["assetExtraction"][0]["id"], "P08")
        self.assertEqual(normalized["assetRequirements"][0]["assetId"], "P08")
        self.assertEqual(normalized["assetRequirements"][0]["componentAssetId"], "P08-OBJ")
        self.assertEqual(normalized["assetRequirements"][0]["shotId"], "S04")
        self.assertEqual(normalized["assetRequirements"][1]["assetId"], "P03-P05")

    def test_prompt_contract_pack_is_saved_and_projected_with_quality_coverage(self) -> None:
        prompt_pack = {
            "schemaVersion": "2.0",
            "assetType": "scene",
            "identityAnchor": "同一座雨夜祠堂",
            "characterDetails": {},
            "sceneDetails": {
                "locationAndFunction": "建立关系的乡村祠堂",
                "geography": {"foreground": "湿石阶", "midground": "空旷院落", "background": "木门与檐下灯"},
                "propsAndSetDressing": ["铜灯", "木门"],
                "surfacesAndMaterials": "吸水石材、旧木与细雨水膜",
                "lightingAndAtmosphere": "雨夜冷蓝环境光与檐下暖灯",
                "actionSpace": "院落中央留出角色进退空间",
                "continuityAnchors": ["木门位置", "檐下暖灯方向"],
            },
            "shotPlan": [{"shotId": "S001", "framing": "中远景", "camera": "平视", "focus": "院落"}],
            "visualStyle": {"medium": "写实电影感", "lighting": "冷暖对比"},
            "referenceStrategy": {"preserve": ["空间轴线"]},
            "continuityChecklist": ["地标位置不漂移"],
            "negativePrompt": ["无可读文字", "无新增建筑"],
        }
        saved = self.client.patch("/api/v2/projects/PRJ_BOARD/assets/SCENE_01", json={
            "expected_revision": 1,
            "asset_class": "scene",
            "prompt": "雨夜祠堂的连续场景，保留湿石阶、院落动作区和檐下暖灯。",
            "prompt_pack": prompt_pack,
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        library = self.client.get("/api/v2/projects/PRJ_BOARD/assets").json()
        scene = next(asset for asset in library["assets"] if asset["id"] == "SCENE_01")
        self.assertEqual(scene["promptPack"]["schemaVersion"], "2.0")
        self.assertEqual(scene["promptQuality"]["status"], "ready")
        self.assertEqual(scene["promptQuality"]["coverage"]["percent"], 100)

    def test_board_revision_conflict_and_invalid_relation_are_rejected(self) -> None:
        payload = self.client.get("/api/v2/projects/PRJ_BOARD/asset-board").json()
        conflict = self.client.put("/api/v2/projects/PRJ_BOARD/asset-board", json={"board": payload["board"], "expected_revision": 99})
        self.assertEqual(conflict.status_code, 409)
        payload["board"]["edges"].append({"id": "bad-edge", "source": "asset:CHAR_01", "target": "missing", "relation": "reference"})
        invalid = self.client.put("/api/v2/projects/PRJ_BOARD/asset-board", json={"board": payload["board"], "expected_revision": 1})
        self.assertEqual(invalid.status_code, 422)

    def test_chatgpt_web_intake_maps_to_pending_qa_and_keeps_source(self) -> None:
        response = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={
                "logical_asset_id": "CHAR_01", "asset_class": "character", "asset_role": "identity-anchor",
                "source_type": "chatgpt-web", "prompt_version": "PROMPT_CHAR_01_001",
                "relevant_shots_json": '["S001"]', "authorization_status": "pending",
            },
            files={"file": ("candidate.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["next_status"], "generated_pending_qa")
        self.assertEqual(payload["artifact"]["source_type"], "chatgpt-web")
        self.assertEqual(payload["artifact"]["status"], "generated_pending_qa")

        library = self.client.get("/api/v2/projects/PRJ_BOARD/assets").json()
        char = next(asset for asset in library["assets"] if asset["id"] == "CHAR_01")
        self.assertFalse(char["readiness"]["ready"])

    def test_environment_alias_is_canonicalized_and_legacy_scene_can_start_qa(self) -> None:
        intake = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "SCENE_01", "asset_class": "environment", "source_type": "chatgpt-web"},
            files={"file": ("scene.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        self.assertEqual(intake.json()["artifact"]["asset_class"], "scene")
        self.assertEqual(intake.json()["artifact"]["qa_owner"], "video-scene-design-director")

        # Recreate the exact legacy row that caused the production-board
        # button to appear inert: raw ``environment`` class, no owner, and an
        # already-blocked artifact from the old mapping path.
        with server.app.state.db.connect() as connection:
            connection.execute(
                "UPDATE artifacts SET asset_class='environment',qa_owner=NULL,status='audit_blocked',collection='unqualified',intake_status='audit_blocked' WHERE id=?",
                (artifact_id,),
            )
        started = self.client.post(
            f"/api/v2/projects/PRJ_BOARD/artifacts/{artifact_id}/qa-runs",
            json={"qa_type": "image", "manual_review": True},
        )
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["qa_run"]["qa_owner"], "video-scene-design-director")
        self.assertEqual(started.json()["artifact"]["asset_class"], "scene")
        self.assertEqual(started.json()["artifact"]["status"], "qa_in_progress")

        approved = self.client.post(
            f"/api/v2/projects/PRJ_BOARD/qa-runs/{started.json()['qa_run']['id']}/submit",
            json={"decision": "Approved", "report": {"manual_review": True, "scene_checks": ["layout", "lighting", "continuity"]}},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["artifact"]["status"], "approved_pending_registration")

    def test_archive_candidate_hides_thumbnail_preserves_file_and_allows_replacement(self) -> None:
        initial = self.client.get("/api/v2/projects/PRJ_BOARD/asset-board")
        self.assertEqual(initial.status_code, 200, initial.text)
        intake = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web"},
            files={"file": ("candidate.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        intake_payload = intake.json()
        artifact = intake_payload["artifact"]
        artifact_id = artifact["id"]
        source_path = Path(artifact["local_path"])
        self.assertTrue(source_path.is_file())

        synced = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-board/sync",
            json={"expected_revision": intake_payload["asset_board"]["revision"], "preserve_layout": True},
        )
        self.assertEqual(synced.status_code, 200, synced.text)
        handoff_before = next(node for node in synced.json()["board"]["nodes"] if node["id"] == "handoff:CHAR_01")
        self.assertEqual(handoff_before["config"]["artifact_id"], artifact_id)

        archived = self.client.delete(f"/api/v2/projects/PRJ_BOARD/artifacts/{artifact_id}")
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertEqual(archived.json()["status"], "archived")
        self.assertTrue(archived.json()["file_preserved"])
        self.assertTrue(source_path.is_file())
        handoff_after = next(node for node in archived.json()["asset_board"]["board"]["nodes"] if node["id"] == "handoff:CHAR_01")
        self.assertIsNone(handoff_after["config"]["artifact_id"])
        self.assertFalse(any(node["node_type"] == "artifact" and not (node.get("config") or {}).get("archived") for node in archived.json()["asset_board"]["board"]["nodes"]))
        library_asset = next(asset for asset in archived.json()["library"]["assets"] if asset["id"] == "CHAR_01")
        self.assertEqual(library_asset["workflow"]["next_action"]["code"], "upload_candidate")
        self.assertEqual(next(item for item in library_asset["artifacts"] if item["id"] == artifact_id)["status"], "archived")
        self.assertTrue(any(item["queue"] == "archived" and item["artifact"]["id"] == artifact_id for item in self.client.get("/api/v2/projects/PRJ_BOARD/asset-audit").json()["items"]))

        replacement = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web"},
            files={"file": ("replacement.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(replacement.status_code, 200, replacement.text)
        self.assertNotEqual(replacement.json()["artifact"]["id"], artifact_id)

    def test_asset_board_sync_refreshes_prompt_card_after_candidate_intake(self) -> None:
        initial = self.client.get("/api/v2/projects/PRJ_BOARD/asset-board")
        self.assertEqual(initial.status_code, 200, initial.text)
        response = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web"},
            files={"file": ("candidate.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        response_payload = response.json()
        artifact_id = response_payload["artifact"]["id"]

        synced = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-board/sync",
            json={"expected_revision": response_payload["asset_board"]["revision"], "preserve_layout": True},
        )
        self.assertEqual(synced.status_code, 200, synced.text)
        handoff = next(node for node in synced.json()["board"]["nodes"] if node["id"] == "handoff:CHAR_01")
        self.assertEqual(handoff["config"]["artifact_id"], artifact_id)
        self.assertTrue(handoff["config"]["artifact_url"].endswith("candidate.png"))

    def test_v3_qa_and_registration_keep_active_version_gated(self) -> None:
        intake = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web", "prompt_version": "PROMPT_CHAR_01_002"},
            files={"file": ("candidate.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        before_qa = self.client.get("/api/v2/projects/PRJ_BOARD/assets").json()
        self.assertFalse(next(asset for asset in before_qa["assets"] if asset["id"] == "CHAR_01")["readiness"]["ready"])

        qa = self.client.post(f"/api/v2/projects/PRJ_BOARD/artifacts/{artifact_id}/qa-runs", json={"qa_type": "prompt"})
        self.assertEqual(qa.status_code, 200, qa.text)
        qa_run_id = qa.json()["qa_run"]["id"]
        approved = self.client.post(f"/api/v2/projects/PRJ_BOARD/qa-runs/{qa_run_id}/submit", json={"decision": "Approved", "report": {"manual_review": True}})
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["artifact"]["status"], "approved_pending_registration")

        registered = self.client.post(f"/api/v2/projects/PRJ_BOARD/artifacts/{artifact_id}/register", json={"replace_active": False})
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertTrue(registered.json()["is_active"])
        library = self.client.get("/api/v2/projects/PRJ_BOARD/assets").json()
        char = next(asset for asset in library["assets"] if asset["id"] == "CHAR_01")
        self.assertTrue(char["readiness"]["ready"])
        self.assertTrue(any(version["is_active"] for version in char["versions"]))
        protected = self.client.delete(f"/api/v2/projects/PRJ_BOARD/artifacts/{artifact_id}")
        self.assertEqual(protected.status_code, 409, protected.text)

    def test_new_logical_asset_is_added_without_replacing_board(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_BOARD/assets", json={"expected_revision": 1, "name": "物证袋", "asset_class": "prop", "asset_role": "evidence", "required": True})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["revision"], 2)
        board = self.client.post("/api/v2/projects/PRJ_BOARD/asset-board/sync", json={"expected_revision": 1, "preserve_layout": True})
        self.assertEqual(board.status_code, 200, board.text)
        self.assertTrue(any(node["label"] == "物证袋" for node in board.json()["board"]["nodes"]))

    def test_asset_copy_and_delete_remove_all_canvas_content(self) -> None:
        intake = self.client.post(
            "/api/v2/projects/PRJ_BOARD/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web"},
            files={"file": ("candidate.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        copied = self.client.post(
            "/api/v2/projects/PRJ_BOARD/assets/CHAR_01/duplicate",
            json={"expected_revision": 1, "name": "陈继业 · 副本"},
        )
        self.assertEqual(copied.status_code, 200, copied.text)
        copied_id = copied.json()["asset"]["id"]
        self.assertNotEqual(copied_id, "CHAR_01")
        self.assertTrue(any(item["logical_asset_id"] == copied_id for item in copied.json()["asset"]["artifacts"]))

        synced = self.client.post("/api/v2/projects/PRJ_BOARD/asset-board/sync", json={"expected_revision": intake.json()["asset_board"]["revision"], "preserve_layout": True})
        self.assertEqual(synced.status_code, 200, synced.text)
        self.assertTrue(any(node.get("asset_id") == copied_id for node in synced.json()["board"]["nodes"]))

        deleted = self.client.delete(f"/api/v2/projects/PRJ_BOARD/assets/{copied_id}?expected_revision=2")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertFalse(any(asset["id"] == copied_id for asset in deleted.json()["library"]["assets"]))
        self.assertFalse(any(node.get("asset_id") == copied_id for node in deleted.json()["asset_board"]["board"]["nodes"]))

        resynced = self.client.post("/api/v2/projects/PRJ_BOARD/asset-board/sync", json={"expected_revision": deleted.json()["asset_board"]["revision"], "preserve_layout": True})
        self.assertEqual(resynced.status_code, 200, resynced.text)
        self.assertFalse(any(node.get("asset_id") == copied_id for node in resynced.json()["board"]["nodes"]))


if __name__ == "__main__":
    unittest.main()
