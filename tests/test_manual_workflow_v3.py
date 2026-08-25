from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


VIDEO_STUB = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"


class ManualWorkflowV3Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-manual-workflow-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop(); self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():candidate.unlink()

    def test_no_provider_manual_project_to_render_gate_workflow(self) -> None:
        with mock.patch.object(server,"resolve_profile",side_effect=AssertionError("Provider must not be used")):
            created=self.client.post("/api/v2/projects",json={"name":"Manual only","ratio":"16:9","duration":6,"generator":"manual","brief":"no provider"})
            self.assertEqual(created.status_code,201,created.text);project_id=created.json()["document"]["id"]
            story=self.client.get(f"/api/v2/projects/{project_id}/story").json()
            shot={"id":"SH-MANUAL-001","scene":"SC-MANUAL-001","duration":4,"purpose":"manual delivery","size":"中景","camera":"固定","action":"人物进入","status":"ready","assetRequirements":[]}
            saved_story=self.client.put(f"/api/v2/projects/{project_id}/story",json={"expected_revision":story["revision"],"spec":story["story"]["spec"],"script":"人工剧本","scenes":[{"id":"SC-MANUAL-001","name":"人工场景"}],"shots":[shot]})
            self.assertEqual(saved_story.status_code,200,saved_story.text)
            asset=self.client.post(f"/api/v2/projects/{project_id}/assets",json={"expected_revision":saved_story.json()["revision"],"name":"SH-MANUAL-001 正式视频","asset_class":"video","asset_role":"approved_shot","grade":"A","required":True})
            self.assertEqual(asset.status_code,200,asset.text);logical_id=asset.json()["asset"]["id"]
            intake=self.client.post(f"/api/v2/projects/{project_id}/asset-intake",data={"logical_asset_id":logical_id,"asset_class":"video","asset_role":"approved_shot","source_type":"manual-upload","relevant_shots_json":"[\"SH-MANUAL-001\"]"},files={"file":("SH-MANUAL-001.mp4",VIDEO_STUB,"video/mp4")})
            self.assertEqual(intake.status_code,200,intake.text);artifact_id=intake.json()["artifact"]["id"]
            qa=self.client.post(f"/api/v2/projects/{project_id}/artifacts/{artifact_id}/qa-runs",json={"qa_type":"video","manual_review":True})
            self.assertEqual(qa.status_code,200,qa.text)
            checks={key:True for key in ("file_playable","duration_target","technical_format","first_last_frame","content_match","continuity","visual_artifacts","av_sync","lineage_complete")}
            approved=self.client.post(f"/api/v2/projects/{project_id}/qa-runs/{qa.json()['qa_run']['id']}/submit",json={"decision":"Approved","report":{"manual_review":True,"video_checks":checks}})
            self.assertEqual(approved.status_code,200,approved.text)
            registered=self.client.post(f"/api/v2/projects/{project_id}/artifacts/{artifact_id}/register",json={"replace_active":True})
            self.assertEqual(registered.status_code,200,registered.text);self.assertTrue(registered.json()["is_active"])
            current_story=self.client.get(f"/api/v2/projects/{project_id}/story").json();shot["status"]="approved";shot["directorApproved"]=True;shot["artifactId"]=artifact_id
            linked=self.client.put(f"/api/v2/projects/{project_id}/story",json={"expected_revision":current_story["revision"],"spec":current_story["story"]["spec"],"script":current_story["story"]["script"],"scenes":current_story["story"]["scenes"],"shots":[shot]})
            self.assertEqual(linked.status_code,200,linked.text)
            timeline=self.client.get(f"/api/v2/projects/{project_id}/timeline").json();assembled=self.client.post(f"/api/v2/projects/{project_id}/timeline/assemble",json={"expected_revision":timeline["revision"]})
            self.assertEqual(assembled.status_code,200,assembled.text);self.assertEqual(assembled.json()["assembly"]["added_video_clips"],1)
            preflight=self.client.get(f"/api/v2/projects/{project_id}/timeline/preflight")
            self.assertTrue(preflight.json()["summary"]["delivery_ready"],preflight.text)
            render=self.client.post("/api/v2/renders",json={"project_id":project_id,"timeline_revision":assembled.json()["revision"]})
            self.assertEqual(render.status_code,200,render.text);self.assertEqual(render.json()["status"],"awaiting_confirmation")


if __name__=="__main__":unittest.main()
