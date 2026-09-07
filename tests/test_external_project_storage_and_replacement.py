from __future__ import annotations

import base64
import shutil
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def replacement_project() -> dict:
    return {
        "id": "PRJ_REPLACEMENT",
        "name": "登记后替换验收",
        "ratio": "16:9",
        "duration": 4,
        "generator": "manual",
        "brief": "验证外部资源目录、Prompt 联动和登记后图片替换。",
        "stage": 0,
        "sortOrder": 0,
        "script": "",
        "assets": [{
            "id": "CHAR_01",
            "name": "主角",
            "skill": "character",
            "assetClass": "character",
            "assetRole": "identity",
            "grade": "A",
            "required": True,
            "prompt": "一名可连续使用的角色设计图，保留面部身份锚点。",
            "status": "missing",
        }, {
            "id": "ENV_01",
            "name": "未来平台",
            "skill": "scene",
            "assetClass": "scene",
            "assetRole": "environment",
            "grade": "A",
            "required": True,
            "prompt": "一座可连续使用的未来平台场景，保留空间布局和冷色灯光锚点。",
            "status": "missing",
        }],
        "shots": [],
        "audio": {},
        "assetRegulator": {},
        "generations": [],
        "seedancePackages": [],
        "providerOverrides": {},
        "undoStack": [],
        "scriptVersions": [],
        "storyboardVersions": [],
        "storyWorkflowRuns": [],
    }


class ExternalProjectStorageAndReplacementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-external-storage-{uuid.uuid4().hex}.db"
        self.runtime_root = Path("/tmp") / f"frameflow-runtime-{self.db_path.stem}"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.context = TestClient(server.app)
        self.client = self.context.__enter__()
        created = self.client.put(f"/api/v2/projects/{replacement_project()['id']}", json={"document": replacement_project()})
        self.assertEqual(created.status_code, 200, created.text)

    def tearDown(self) -> None:
        self.context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()
        if self.runtime_root.is_dir():
            shutil.rmtree(self.runtime_root)

    def _approved_registered_artifact(self, filename: str = "candidate.png", logical_asset_id: str = "CHAR_01", asset_class: str = "character") -> tuple[str, int]:
        prompt = self.client.post(
            f"/api/v2/projects/PRJ_REPLACEMENT/assets/{logical_asset_id}/prompt-versions",
            json={"prompt": "一名可连续使用的角色设计图，保留面部身份锚点。" if logical_asset_id == "CHAR_01" else "一座可连续使用的未来平台场景，保留空间布局和冷色灯光锚点。", "source": "external-chatgpt", "change_reason": "外部 ChatGPT 生成包"},
        )
        self.assertEqual(prompt.status_code, 200, prompt.text)
        prompt_version = prompt.json()["prompt_version"]
        intake = self.client.post(
            "/api/v2/projects/PRJ_REPLACEMENT/asset-intake",
            data={"logical_asset_id": logical_asset_id, "asset_class": asset_class, "source_type": "chatgpt-web", "prompt_version": prompt_version["id"]},
            files={"file": (filename, PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        started = self.client.post(f"/api/v2/projects/PRJ_REPLACEMENT/artifacts/{artifact_id}/qa-runs", json={"qa_type": "image", "manual_review": True})
        self.assertEqual(started.status_code, 200, started.text)
        submitted = self.client.post(
            f"/api/v2/projects/PRJ_REPLACEMENT/qa-runs/{started.json()['qa_run']['id']}/submit",
            json={"decision": "Approved", "report": {"manual_review": True, "image_checks": ["identity", "continuity"]}},
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        registered = self.client.post(f"/api/v2/projects/PRJ_REPLACEMENT/artifacts/{artifact_id}/register", json={"replace_active": False})
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertEqual(registered.json()["prompt_qa"]["status"], "auto_approved")
        return artifact_id, int(registered.json()["project_revision"])

    def test_external_workspace_auto_syncs_prompt_storyboard_and_registration_history(self) -> None:
        artifact_id, revision = self._approved_registered_artifact()
        root = server.DATA_DIR / "projects" / "PRJ_REPLACEMENT"
        self.assertTrue((root / "project.json").is_file())
        self.assertTrue((root / "story" / "script.md").is_file())
        self.assertTrue((root / "story" / "storyboard.md").is_file())
        self.assertTrue((root / "story" / "storyboard.json").is_file())
        self.assertTrue((root / "assets" / "characters" / "prompts" / "CHAR_01" / "current.md").is_file())
        self.assertTrue((root / "assets" / "manifest.json").is_file())
        self.assertTrue((root / "qa" / "asset-qa.json").is_file())
        self.assertIn("面部身份锚点", (root / "assets" / "characters" / "prompts" / "CHAR_01" / "current.md").read_text(encoding="utf-8"))
        storage = self.client.get("/api/v2/projects/PRJ_REPLACEMENT/storage")
        self.assertEqual(storage.status_code, 200, storage.text)
        self.assertEqual(Path(storage.json()["root"]), root.resolve())
        self.assertEqual(storage.json()["layout_version"], 1)
        self.assertEqual(self.client.post("/api/v2/projects/PRJ_REPLACEMENT/storage/sync").status_code, 200)
        self.assertTrue((root / "assets" / "characters" / "prompts" / "CHAR_01" / "versions").is_dir())
        self.assertTrue(artifact_id)
        self.assertGreaterEqual(revision, 2)

    def test_registered_image_can_be_withdrawn_then_reuploaded_without_losing_history(self) -> None:
        artifact_id, revision = self._approved_registered_artifact("registered.png")
        with server.app.state.db.connect() as connection:
            artifact_row = connection.execute("SELECT local_path FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        original_path = Path(artifact_row["local_path"])
        self.assertTrue(original_path.is_file())

        removed = self.client.delete(f"/api/v2/projects/PRJ_REPLACEMENT/assets/CHAR_01/active-version?expected_revision={revision}")
        self.assertEqual(removed.status_code, 200, removed.text)
        payload = removed.json()
        self.assertTrue(payload["active_removed"])
        self.assertTrue(payload["file_preserved"])
        self.assertTrue(payload["replacement_required"])
        self.assertTrue(original_path.is_file())
        asset = next(item for item in payload["library"]["assets"] if item["id"] == "CHAR_01")
        self.assertFalse(asset["readiness"]["registered_ready"])
        self.assertFalse(asset["readiness"]["production_ready"])
        self.assertIsNone(asset.get("artifactId"))
        self.assertFalse(asset.get("regulatorRegistered"))
        self.assertFalse(any(version["is_active"] for version in asset["versions"]))
        self.assertEqual(next(item for item in asset["artifacts"] if item["id"] == artifact_id)["status"], "archived")
        handoff = next(node for node in payload["asset_board"]["board"]["nodes"] if node["id"] == "handoff:CHAR_01")
        self.assertIsNone(handoff["config"]["artifact_id"])

        replacement = self.client.post(
            "/api/v2/projects/PRJ_REPLACEMENT/asset-intake",
            data={"logical_asset_id": "CHAR_01", "asset_class": "character", "source_type": "chatgpt-web"},
            files={"file": ("replacement.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(replacement.status_code, 200, replacement.text)
        self.assertNotEqual(replacement.json()["artifact"]["id"], artifact_id)
        audit = self.client.get("/api/v2/projects/PRJ_REPLACEMENT/asset-audit?queue=archived")
        self.assertEqual(audit.status_code, 200, audit.text)
        self.assertTrue(any(item.get("artifact", {}).get("id") == artifact_id for item in audit.json()["items"]))

    def test_two_registered_images_can_be_withdrawn_sequentially_with_returned_revisions(self) -> None:
        first_artifact, first_revision = self._approved_registered_artifact("first.png", "CHAR_01", "character")
        second_artifact, second_revision = self._approved_registered_artifact("second.png", "ENV_01", "scene")
        self.assertGreater(second_revision, first_revision)

        first_removed = self.client.delete(f"/api/v2/projects/PRJ_REPLACEMENT/assets/CHAR_01/active-version?expected_revision={second_revision}")
        self.assertEqual(first_removed.status_code, 200, first_removed.text)
        first_payload = first_removed.json()
        self.assertTrue(first_payload["active_removed"])
        self.assertEqual(first_payload["artifact_id"], first_artifact)

        second_removed = self.client.delete(
            f"/api/v2/projects/PRJ_REPLACEMENT/assets/ENV_01/active-version?expected_revision={first_payload['project_revision']}"
        )
        self.assertEqual(second_removed.status_code, 200, second_removed.text)
        second_payload = second_removed.json()
        self.assertTrue(second_payload["active_removed"])
        self.assertEqual(second_payload["artifact_id"], second_artifact)
        self.assertGreater(second_payload["project_revision"], first_payload["project_revision"])


if __name__ == "__main__":
    unittest.main()
