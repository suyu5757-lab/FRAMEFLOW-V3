from __future__ import annotations

import base64
import hashlib
import sqlite3
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
VIDEO_STUB = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"


def project_document() -> dict:
    return {
        "id": "PRJ_ASSET_V3", "name": "资产模块验收", "ratio": "16:9", "duration": 8,
        "generator": "manual", "brief": "V3 资产流程", "stage": 0, "sortOrder": 0,
        "script": "", "assets": [
            {"id": "C001", "name": "角色一", "skill": "character", "assetClass": "character", "grade": "A", "prompt": "", "artifactId": "ART_CURRENT", "qaDecision": "Approved", "regulatorRegistered": True, "status": "ready"},
            {"id": "S001", "name": "场景一", "skill": "scene", "assetClass": "scene", "grade": "A", "status": "missing"},
        ],
        "shots": [{"id": "SH001", "scene": "室内", "duration": 4, "purpose": "建立关系", "assetRequirements": []}, {"id": "SH002", "scene": "室外", "duration": 4, "purpose": "冲突", "assetRequirements": []}],
        "audio": {}, "assetRegulator": {}, "generations": [], "seedancePackages": [], "providerOverrides": {},
        "undoStack": [], "scriptVersions": [], "storyboardVersions": [], "storyWorkflowRuns": [],
    }


class AssetV3ImprovementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-asset-v3-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        response = self.client.put("/api/v2/projects/PRJ_ASSET_V3", json={"document": project_document()})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_library_has_two_readiness_dimensions_and_audit_queue(self) -> None:
        library = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets")
        self.assertEqual(library.status_code, 200, library.text)
        payload = library.json()
        self.assertEqual(payload["summary"]["total"], 2)
        self.assertEqual(payload["summary"]["registered_ready"], 1)
        self.assertEqual(payload["summary"]["production_ready"], 0)
        character = next(item for item in payload["assets"] if item["id"] == "C001")
        self.assertTrue(character["readiness"]["registered_ready"])
        self.assertFalse(character["readiness"]["production_ready"])
        self.assertIn("prompt", character["readiness"]["production_missing"])
        audit = self.client.get("/api/v2/projects/PRJ_ASSET_V3/asset-audit?queue=all")
        self.assertEqual(audit.status_code, 200, audit.text)
        self.assertIn("待登记", audit.json()["counts"])

    def test_library_query_contract_paginates_filters_and_sorts_server_side(self) -> None:
        first = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets?page=1&page_size=1&asset_type=character&sort=id")
        self.assertEqual(first.status_code, 200, first.text)
        payload = first.json()
        self.assertEqual(payload["pagination"], {"page": 1, "page_size": 1, "total": 1, "page_count": 1, "paginated": True})
        self.assertEqual([asset["id"] for asset in payload["assets"]], ["C001"])
        search = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets?page=1&page_size=10&q=场景&sort=id")
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual([asset["id"] for asset in search.json()["assets"]], ["S001"])
        self.assertEqual(self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets?page=0").status_code, 422)

    def test_prompt_edit_creates_new_version_and_resets_qa(self) -> None:
        created = self.client.post("/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions", json={"prompt": "角色一的新 Prompt", "source": "asset-library", "change_reason": "修订身份锚点"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["prompt_version"]["version"], 1)
        self.assertEqual(created.json()["prompt_version"]["status"], "prompt_qa_pending")
        versions = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions")
        self.assertEqual(len(versions.json()["prompt_versions"]), 1)
        library = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets").json()
        character = next(item for item in library["assets"] if item["id"] == "C001")
        self.assertEqual(character["promptQaDecision"], "Pending")
        self.assertFalse(character["readiness"]["production_ready"])
        patched = self.client.patch("/api/v2/projects/PRJ_ASSET_V3/assets/C001", json={"expected_revision": 2, "prompt": "角色一的第二版 Prompt", "asset_class": "character"})
        self.assertEqual(patched.status_code, 200, patched.text)
        self.assertEqual(len(self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions").json()["prompt_versions"]), 2)

    def test_approving_new_prompt_atomically_supersedes_previous_authority(self) -> None:
        first = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions",
            json={"prompt": "Approved Prompt v1", "source": "asset-library"},
        ).json()["prompt_version"]
        approved_first = self.client.post(
            f"/api/v2/projects/PRJ_ASSET_V3/prompt-versions/{first['id']}/qa",
            json={"decision": "Approved", "report": {"reviewed": True}},
        )
        self.assertEqual(approved_first.status_code, 200, approved_first.text)
        self.assertEqual(approved_first.json()["prompt_version"]["status"], "prompt_qa_approved")

        second = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions",
            json={"prompt": "Approved Prompt v2", "source": "asset-library"},
        ).json()["prompt_version"]
        approved_second = self.client.post(
            f"/api/v2/projects/PRJ_ASSET_V3/prompt-versions/{second['id']}/qa",
            json={"decision": "Approved", "report": {"reviewed": True}},
        )
        self.assertEqual(approved_second.status_code, 200, approved_second.text)
        versions = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions").json()["prompt_versions"]
        by_id = {item["id"]: item for item in versions}
        self.assertEqual(by_id[first["id"]]["status"], "superseded")
        self.assertEqual(by_id[second["id"]]["status"], "prompt_qa_approved")
        self.assertEqual(sum(item["status"] == "prompt_qa_approved" for item in versions), 1)
        with self.assertRaises(sqlite3.IntegrityError):
            with server.app.state.db.connect() as connection:
                connection.execute("UPDATE prompt_versions SET status='prompt_qa_approved' WHERE id=?", (first["id"],))

    def test_asset_image_generation_rejects_tampered_body_and_freezes_canonical_prompt(self) -> None:
        canonical_prompt = "Canonical Approved Prompt — preserve exact body."
        prompt_version = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/prompt-versions",
            json={"prompt": canonical_prompt, "source": "asset-library"},
        ).json()["prompt_version"]
        approved = self.client.post(
            f"/api/v2/projects/PRJ_ASSET_V3/prompt-versions/{prompt_version['id']}/qa",
            json={"decision": "Approved", "report": {"reviewed": True}},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        profile = {"id": "image-test", "provider_type": "openai", "model_config": {"image_model": "image-test-model"}}
        provider_payload = {"model": "image-test-model", "data": [{"b64_json": base64.b64encode(PNG_1X1).decode("ascii")}]}
        with mock.patch.object(server, "resolve_profile", return_value=(profile, None)), mock.patch.object(server, "get_profile_secret", return_value="test-secret"), mock.patch.object(server, "openai_image", new=mock.AsyncMock(return_value=provider_payload)) as image_mock:
            tampered = self.client.post(
                "/api/v2/projects/PRJ_ASSET_V3/assets/C001/generate-image",
                json={"confirmed": True, "prompt_version": prompt_version["id"], "prompt": "tampered body"},
            )
            self.assertEqual(tampered.status_code, 409, tampered.text)
            self.assertEqual(tampered.json()["details"]["prompt_authority"]["code"], "prompt_body_tampered")
            self.assertEqual(image_mock.await_count, 0)
            generated = self.client.post(
                "/api/v2/projects/PRJ_ASSET_V3/assets/C001/generate-image",
                json={"confirmed": True, "prompt_version": prompt_version["id"]},
            )
        self.assertEqual(generated.status_code, 200, generated.text)
        self.assertEqual(image_mock.await_count, 1)
        self.assertEqual(image_mock.await_args.args[2], canonical_prompt)
        expected_hash = hashlib.sha256(canonical_prompt.encode("utf-8")).hexdigest()
        self.assertEqual(generated.json()["prompt_sha256"], expected_hash)
        with server.app.state.db.connect() as connection:
            snapshot = connection.execute("SELECT * FROM generation_snapshots_v9 WHERE id=?", (generated.json()["generation_snapshot_id"],)).fetchone()
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["status"], "succeeded")
        self.assertEqual(snapshot["prompt_version_id"], prompt_version["id"])
        self.assertEqual(snapshot["prompt_sha256"], expected_hash)
        self.assertEqual(snapshot["prompt_body"], canonical_prompt)
        self.assertEqual(snapshot["artifact_id"], generated.json()["artifact"]["id"])

    def test_reference_authority_is_ordered_conflict_resolved_and_frozen(self) -> None:
        now = server.utcnow()
        with server.app.state.db.connect() as connection:
            connection.execute(
                "INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,metadata_json,qa_decision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("ART_REFERENCE", "PRJ_ASSET_V3", "image", "reference.png", "a" * 64, "image/png", "{}", "Approved", "ready", now),
            )
            connection.execute(
                "INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,status,is_active,registration_json,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                ("AV_REFERENCE", "PRJ_ASSET_V3", "C001", "character", 1, "ART_REFERENCE", "active", 1, "{}", now, now),
            )
        updated = self.client.patch("/api/v2/projects/PRJ_ASSET_V3/assets/C001", json={
            "expected_revision": 1,
            "references": [
                {"reference_id": "ART_REFERENCE", "reference_kind": "artifact", "role": "identity", "priority": 20, "scope": "face", "authority": "supporting", "conflict_group": "face-lock"},
                {"reference_id": "camera-card", "reference_kind": "url", "role": "composition", "priority": 10, "scope": "camera", "authority": "primary", "conflict_group": "camera-lock"},
            ],
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        _, references, _ = server._asset_relations(server.app.state.db, "PRJ_ASSET_V3", "C001")
        self.assertEqual([item["priority"] for item in references], [10, 20])
        stored = next(item for item in references if item["reference_id"] == "ART_REFERENCE")
        self.assertEqual(stored["effective_version"], "AV_REFERENCE")
        snapshot = server._generation_reference_snapshot(server.app.state.db, "PRJ_ASSET_V3", "C001")
        self.assertEqual([item["reference_id"] for item in snapshot], ["camera-card", "ART_REFERENCE"])
        self.assertEqual(snapshot[0]["conflict_winner_reference_id"], "camera-card")
        self.assertEqual(snapshot[1]["asset_version_id"], "AV_REFERENCE")
        self.assertEqual(snapshot[1]["artifact_sha256"], "a" * 64)

        conflict = self.client.patch("/api/v2/projects/PRJ_ASSET_V3/assets/C001", json={
            "expected_revision": 2,
            "references": [
                {"reference_id": "first", "reference_kind": "url", "role": "identity", "priority": 1, "scope": "face", "authority": "absolute", "conflict_group": "face-lock"},
                {"reference_id": "second", "reference_kind": "url", "role": "identity", "priority": 2, "scope": "face", "authority": "absolute", "conflict_group": "face-lock"},
            ],
        })
        self.assertEqual(conflict.status_code, 422, conflict.text)
        self.assertIn("multiple_absolute_authorities", conflict.text)

    def test_manual_production_approval_is_narrow_revision_protected_and_reversible(self) -> None:
        approved = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/manual-production-approval",
            json={"expected_revision": 1, "approved": True, "reason": "导演已人工确认当前登记图像可直接入镜。", "artifact_id": "ART_CURRENT"},
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        character = approved.json()["asset"]
        self.assertTrue(character["readiness"]["production_ready"])
        self.assertTrue(character["readiness"]["manual_approval_active"])
        self.assertEqual(character["readiness"]["manual_production_approval"]["artifactId"], "ART_CURRENT")

        revoked = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/manual-production-approval",
            json={"expected_revision": 2, "approved": False, "reason": "撤销人工通过", "artifact_id": "ART_CURRENT"},
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        character = revoked.json()["asset"]
        self.assertFalse(character["readiness"]["production_ready"])
        self.assertFalse(character["readiness"]["manual_approval_active"])

        conflict = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/assets/C001/manual-production-approval",
            json={"expected_revision": 1, "approved": True, "reason": "过期版本不应通过", "artifact_id": "ART_CURRENT"},
        )
        self.assertEqual(conflict.status_code, 409)

    def test_batch_candidate_detail_is_controlled_and_atomic_assignment_syncs(self) -> None:
        intake = self.client.post("/api/v2/projects/PRJ_ASSET_V3/asset-intake", data={"logical_asset_id": "C001", "asset_class": "character", "source_type": "asset-library-batch"}, files={"file": ("candidate.png", PNG_1X1, "image/png")})
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        detail = self.client.get(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertTrue(detail.json()["url"].startswith("/api/project-files/PRJ_ASSET_V3/"))
        board = self.client.get("/api/v2/projects/PRJ_ASSET_V3/asset-board").json()
        assignment = self.client.post("/api/v2/projects/PRJ_ASSET_V3/asset-assignments", json={"expected_project_revision": 1, "expected_board_revision": board["revision"], "asset_id": "C001", "shot_id": "SH002", "mode": "assign", "required_readiness": "production"})
        self.assertEqual(assignment.status_code, 200, assignment.text)
        payload = assignment.json()
        self.assertEqual(payload["project_revision"], 2)
        self.assertTrue(any(item.get("assetId") == "C001" for item in next(shot for shot in payload["story"]["shots"] if shot["id"] == "SH002")["assetRequirements"]))
        self.assertTrue(any(edge["relation"] == "shot_dependency" and edge["source"] == "shot:SH002" for edge in payload["asset_board"]["board"]["edges"]))
        conflict = self.client.post("/api/v2/projects/PRJ_ASSET_V3/asset-assignments", json={"expected_project_revision": 1, "expected_board_revision": payload["board_revision"], "asset_id": "C001", "shot_id": "SH001", "mode": "assign"})
        self.assertEqual(conflict.status_code, 409)

    def test_storyboard_reference_uses_reference_review_and_cannot_be_registered(self) -> None:
        document = project_document()
        document["assets"].append({"id": "REF009", "name": "SH009 分镜参考", "skill": "video", "assetClass": "video", "grade": "A", "status": "missing"})
        updated = self.client.put("/api/v2/projects/PRJ_ASSET_V3", json={"document": document})
        self.assertEqual(updated.status_code, 200, updated.text)
        intake = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/asset-intake",
            data={"logical_asset_id": "REF009", "asset_class": "video", "asset_role": "storyboard_reference", "source_type": "storyboard"},
            files={"file": ("storyboard-SH009.png", PNG_1X1, "image/png")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        self.assertEqual(intake.json()["next_status"], "reference_pending_review")
        library = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets").json()
        reference = next(item for item in library["assets"] if item["id"] == "REF009")
        self.assertEqual(reference["workflow"]["kind"], "reference")
        self.assertEqual(reference["workflow"]["qa_type"], "reference")
        self.assertFalse(reference["readiness"]["production_ready"])
        wrong_qa = self.client.post(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}/qa-runs", json={"qa_type": "video", "manual_review": True})
        self.assertEqual(wrong_qa.status_code, 422, wrong_qa.text)
        started = self.client.post(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}/qa-runs", json={"qa_type": "reference", "manual_review": True})
        self.assertEqual(started.status_code, 200, started.text)
        qa_run_id = started.json()["qa_run"]["id"]
        submitted = self.client.post(
            f"/api/v2/projects/PRJ_ASSET_V3/qa-runs/{qa_run_id}/submit",
            json={"decision": "Approved", "report": {"reference_use": "构图与连续性检查"}},
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        registered = self.client.post(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}/register", json={"replace_active": False})
        self.assertEqual(registered.status_code, 409, registered.text)
        self.assertIn("reference", registered.text.lower())

    def test_video_candidate_requires_video_qa(self) -> None:
        document = project_document()
        document["assets"].append({"id": "VID009", "name": "SH009 正式视频", "skill": "video", "assetClass": "video", "assetRole": "approved_shot", "grade": "A", "status": "missing"})
        updated = self.client.put("/api/v2/projects/PRJ_ASSET_V3", json={"document": document})
        self.assertEqual(updated.status_code, 200, updated.text)
        intake = self.client.post(
            "/api/v2/projects/PRJ_ASSET_V3/asset-intake",
            data={"logical_asset_id": "VID009", "asset_class": "video", "asset_role": "approved_shot", "source_type": "video-shot-director"},
            files={"file": ("SH009.mp4", VIDEO_STUB, "video/mp4")},
        )
        self.assertEqual(intake.status_code, 200, intake.text)
        artifact_id = intake.json()["artifact"]["id"]
        self.assertEqual(intake.json()["next_status"], "generated_pending_qa")
        library = self.client.get("/api/v2/projects/PRJ_ASSET_V3/assets").json()
        video = next(item for item in library["assets"] if item["id"] == "VID009")
        self.assertEqual(video["workflow"]["qa_type"], "video")
        wrong_qa = self.client.post(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}/qa-runs", json={"qa_type": "image", "manual_review": True})
        self.assertEqual(wrong_qa.status_code, 422, wrong_qa.text)
        started = self.client.post(f"/api/v2/projects/PRJ_ASSET_V3/artifacts/{artifact_id}/qa-runs", json={"qa_type": "video", "manual_review": True})
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["qa_run"]["qa_type"], "video")
        incomplete = self.client.post(
            f"/api/v2/projects/PRJ_ASSET_V3/qa-runs/{started.json()['qa_run']['id']}/submit",
            json={"decision": "Approved", "report": {"manual_review": True}},
        )
        self.assertEqual(incomplete.status_code, 422, incomplete.text)


if __name__ == "__main__":
    unittest.main()
