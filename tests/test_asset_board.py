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
            "assets": [{"id": "SCENE_01", "name": "祠堂", "assetClass": "scene", "prompt": "雨夜祠堂的完整场景 Prompt", "promptPack": {}, "relevantShots": ["S001"]}],
            "fusionPlans": [],
        }
        with mock.patch.object(server, "_run_regulator_agent", new=mock.AsyncMock(return_value=regulator)), mock.patch.object(server, "_run_asset_prompt_agent", new=mock.AsyncMock(return_value=prompt_output)):
            response = self.client.post("/api/v2/projects/PRJ_BOARD/asset-prompt-runs", json={"expected_revision": 1, "target_asset_id": "SCENE_01"})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["run"]["promptCards"][0]["prompt"], "雨夜祠堂的完整场景 Prompt")
        scene = next(asset for asset in payload["library"]["assets"] if asset["id"] == "SCENE_01")
        self.assertEqual(scene.get("prompt", ""), "")
        character = next(asset for asset in payload["library"]["assets"] if asset["id"] == "CHAR_01")
        self.assertEqual(character.get("prompt"), "角色正面设定")

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

        synced = self.client.post("/api/v2/projects/PRJ_BOARD/asset-board/sync", json={"expected_revision": 1, "preserve_layout": True})
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
