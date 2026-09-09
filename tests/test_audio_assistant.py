from __future__ import annotations

import asyncio
import re
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow.audio_assistant import normalize_voice_preparation_result
from frameflow.providers import minimax_documented_voice_catalog


def project_document(project_id: str) -> dict:
    return {
        "id": project_id,
        "name": "声音助手测试项目",
        "ratio": "16:9",
        "duration": 10,
        "generator": "V3 local",
        "brief": "测试声音前置准备",
        "assets": [{
            "id": "AUD001",
            "name": "对白逻辑资产",
            "assetClass": "audio",
            "assetRole": "dialogue",
            "status": "missing",
        }],
        "shots": [{"id": "SH001", "duration": 4, "purpose": "校园放学后的对白"}],
        "audio": {
            "version": 2,
            "schema_version": "minimax-speech-audio-v2",
            "voices": [],
            "auditions": [],
            "dialogues": [],
            "takes": [],
            "music_cues": [],
            "sound_design": [],
            "handoff": {"status": "provisional", "approved_asset_ids": []},
        },
    }


class FakeAudioAssistantAdapter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, str]] = []
        self.response = {
            "structured": {
                "reply": "我已把声音想法整理为可审阅的候选。",
                "proposal": {
                    "state": "ready_for_review",
                    "source_idea": "日本女高中生，甜柔但有校园朝气。",
                    "intent_summary": "日语年轻女性学生角色，清澈轻柔，保留自然活力，避免过度动漫腔。",
                    "voice_candidates": [{
                        "candidate_id": "voice-candidate-1",
                        "provider_voice_id": "Japanese_SportyStudent",
                        "provider_voice_name": "Sporty Student",
                        "language": "Japanese",
                        "locale": "ja-JP",
                        "rationale": "优先验证学生感和活力。",
                    }],
                    "dialogue_candidates": [{
                        "candidate_id": "dialogue-candidate-1",
                        "source_idea": "前辈，今天放学要一起回家吗？",
                        "meaning_cn": "前辈，今天放学后要一起回家吗？",
                        "source_text": "先輩、今日の放課後、一緒に帰りませんか？",
                        "provider_text": "先輩、今日の放課後、一緒に帰りませんか？",
                        "text_status": "candidate",
                        "character_id": "C001",
                        "shot_ids": ["SH001"],
                        "locale": "ja-JP",
                        "language": "Japanese",
                        "dialect": "Standard Japanese",
                    }],
                },
            },
        }

    def supports(self, capability: str) -> bool:
        return capability == "orchestrator"

    def validate_request(self, capability: str, request: dict) -> list[str]:
        return []

    async def submit(self, capability: str, request: dict, credential: str) -> dict:
        self.calls.append((capability, request, credential))
        await asyncio.sleep(0)
        return self.response


class AudioAssistantBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="frameflow-audio-assistant-")
        self.db_path = Path(self.temp_dir.name) / "audio-assistant.db"
        self.project_id = "PRJ_AUDIO_ASSISTANT_" + uuid.uuid4().hex[:8].upper()
        self.adapter = FakeAudioAssistantAdapter()
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.secret_patch = mock.patch.object(server, "get_secret", return_value="test-secret")
        self.profile_secret_patch = mock.patch.object(server, "get_profile_secret", return_value="test-secret")
        self.adapter_patch = mock.patch.object(server, "adapter_for_profile", return_value=self.adapter)
        self.catalog_patch = mock.patch.object(server, "_minimax_voice_catalog_payload", return_value={
            "provider_id": "minimax-default",
            "provider": "minimax",
            "region": "cn",
            "status": "live",
            "catalog_source": "live",
            "voices": [{
                "voice_id": "Japanese_SportyStudent",
                "name": "Sporty Student",
                "source": "system",
                "language": "Japanese",
                "catalog_source": "live",
            }],
            "models": ["speech-2.8-hd"],
        })
        self.db_patch.start()
        self.secret_patch.start()
        self.profile_secret_patch.start()
        self.adapter_patch.start()
        self.catalog_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()
        created = self.client.put(f"/api/v2/projects/{self.project_id}", json={"document": project_document(self.project_id)})
        self.assertEqual(created.status_code, 200, created.text)

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.catalog_patch.stop()
        self.adapter_patch.stop()
        self.profile_secret_patch.stop()
        self.secret_patch.stop()
        self.db_patch.stop()
        runtime_root = Path(tempfile.gettempdir()) / f"frameflow-runtime-{self.db_path.stem}"
        if runtime_root.is_dir():
            import shutil

            shutil.rmtree(runtime_root)
        self.temp_dir.cleanup()

    def wait_for_run(self, run_id: str) -> dict:
        deadline = time.monotonic() + 4
        run = self.client.get(f"/api/v2/assistant/runs/{run_id}").json()
        while run.get("status") not in {"succeeded", "failed", "canceled", "stale_contract"} and time.monotonic() < deadline:
            time.sleep(0.03)
            run = self.client.get(f"/api/v2/assistant/runs/{run_id}").json()
        self.assertEqual(run.get("status"), "succeeded", run)
        return run

    def start_voice_run(self, audio_document: dict) -> dict:
        response = self.client.post(f"/api/v2/projects/{self.project_id}/assistant/stream", json={
            "project_id": self.project_id,
            "assistant_mode": "voice-preparation",
            "skill_id": "voice-preparation-assistant",
            "message": "我想要一位来自日本的女高中生，声音甜柔、有活力，她想说前辈今天放学一起回家吗？",
            "attachment_ids": [],
            "selected_node_ids": [],
            "context": {
                "audio_focus": {"kind": "project", "shot_ids": ["SH001"]},
                "audio_draft": audio_document,
            },
            "cost_boundary": {"currency": "USD", "confirmation_required": True},
            "client_message_id": "audio-" + uuid.uuid4().hex,
        })
        self.assertEqual(response.status_code, 200, response.text)
        match = re.search(r'"run_id":\s*"([^"]+)"', response.text)
        self.assertIsNotNone(match, response.text)
        return self.wait_for_run(str(match.group(1)))

    def test_documented_voice_fallback_is_reference_only(self) -> None:
        result = normalize_voice_preparation_result(
            {"structured": self.adapter.response["structured"]},
            project_document=project_document("P"),
            audio_document=project_document("P")["audio"],
            story_document={"shots": []},
            catalog={"status": "unavailable", "region": "cn", "voices": minimax_documented_voice_catalog()},
            focus={"kind": "project", "shot_ids": []},
            contract_snapshot={"bundle_hash": "a" * 64},
        )
        self.assertEqual(result["proposal"]["voice_candidates"][0]["catalog_source"], "documented")
        self.assertFalse(result["proposal"]["voice_candidates"][0]["selectable"])
        self.assertEqual(result["proposal"]["voice_profiles"], [])
        self.assertTrue(all(item["workspace"] == "audio" for item in result["patch"]["workspace_operations"]))

    def test_voice_run_is_opencode_only_and_audio_draft_apply_is_not_persistent(self) -> None:
        audio = self.client.get(f"/api/v2/projects/{self.project_id}/audio-studio").json()
        audio_document = audio["document"]
        run = self.start_voice_run(audio_document)
        self.assertEqual(run["assistant_mode"], "voice-preparation")
        self.assertEqual(run["skill"]["skill_id"], "voice-preparation-assistant")
        self.assertEqual(len(self.adapter.calls), 1)
        request = self.adapter.calls[0][1]
        self.assertEqual(request["schema_name"], "frameflow_audio_preparation")
        self.assertIn("audio_preparation_context", request["input_text"])
        operations = run["result"]["patch"]["workspace_operations"]
        self.assertTrue(operations)
        self.assertTrue(all(item["workspace"] == "audio" for item in operations))
        self.assertNotIn("generate_audio", repr(operations))

        generic_apply = self.client.post(f"/api/v2/assistant/runs/{run['id']}/apply", json={
            "plan_id": run["result"]["plan_id"],
            "selected_operation_ids": [operations[0]["id"]],
            "expected_project_revision": run["base_project_revision"],
            "expected_graph_revision": run["base_graph_revision"],
            "expected_timeline_revision": run["base_timeline_revision"],
            "expected_contract_bundle_hash": run["contract_hash"],
        })
        self.assertEqual(generic_apply.status_code, 409, generic_apply.text)

        applied = self.client.post(f"/api/v2/assistant/runs/{run['id']}/audio-draft", json={
            "selected_operation_ids": [item["id"] for item in operations],
            "expected_project_revision": run["base_project_revision"],
            "expected_audio_revision": run["result"]["audio_revision"],
            "expected_contract_bundle_hash": run["contract_hash"],
            "base_audio_hash": run["result"]["audio_base_hash"],
            "document": audio_document,
        })
        self.assertEqual(applied.status_code, 200, applied.text)
        payload = applied.json()
        self.assertFalse(payload["persisted"])
        self.assertEqual(payload["project_revision"], audio["revision"])
        self.assertTrue(payload["document"]["dialogues"])
        self.assertEqual(self.client.get(f"/api/v2/projects/{self.project_id}").json()["revision"], audio["revision"])
        self.assertEqual(self.client.get(f"/api/v2/projects/{self.project_id}/audio-studio").json()["document"]["dialogues"], [])

    def test_text_confirmation_records_hash_before_managed_generation(self) -> None:
        audio = self.client.get(f"/api/v2/projects/{self.project_id}/audio-studio").json()
        run = self.start_voice_run(audio["document"])
        operations = run["result"]["patch"]["workspace_operations"]
        applied = self.client.post(f"/api/v2/assistant/runs/{run['id']}/audio-draft", json={
            "selected_operation_ids": [item["id"] for item in operations],
            "expected_project_revision": run["base_project_revision"],
            "expected_audio_revision": run["result"]["audio_revision"],
            "expected_contract_bundle_hash": run["contract_hash"],
            "base_audio_hash": run["result"]["audio_base_hash"],
            "document": audio["document"],
        })
        self.assertEqual(applied.status_code, 200, applied.text)
        draft = applied.json()["document"]
        saved = self.client.put(f"/api/v2/projects/{self.project_id}/audio-studio", json={
            "document": draft,
            "expected_revision": audio["revision"],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        dialogue = saved.json()["document"]["dialogues"][0]
        with mock.patch.object(server, "minimax_speech", new=mock.AsyncMock(return_value=(b"RIFF", {"trace_id": "must-not-run"}))) as speech:
            candidate_generation = self.client.post(f"/api/v2/projects/{self.project_id}/audio/tts", json={
                "text": dialogue["provider_text"],
                "source_text": dialogue["source_text"],
                "provider_text": dialogue["provider_text"],
                "text_status": "candidate",
                "model": "speech-2.8-hd",
                "voice": "Japanese_SportyStudent",
                "voice_id": "V001",
                "dialogue_id": dialogue["id"],
                "logical_asset_id": "AUD001",
                "confirmed": False,
            })
        self.assertEqual(candidate_generation.status_code, 409, candidate_generation.text)
        speech.assert_not_awaited()
        confirmed = self.client.post(f"/api/v2/projects/{self.project_id}/audio/text-confirmation", json={
            "target_type": "dialogue",
            "target_id": dialogue["id"],
            "source_text": dialogue["source_text"],
            "provider_text": dialogue["provider_text"],
            "expected_revision": saved.json()["revision"],
        })
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        record = confirmed.json()["document"]["dialogues"][0]
        self.assertEqual(record["text_status"], "confirmed")
        self.assertEqual(record["text_confirmation"]["status"], "confirmed")
        edited_document = confirmed.json()["document"]
        edited_document["dialogues"][0]["text"] = "先輩、また明日。"
        edited_document["dialogues"][0]["source_text"] = "先輩、また明日。"
        edited_document["dialogues"][0]["provider_text"] = "先輩、また明日。"
        edited = self.client.put(f"/api/v2/projects/{self.project_id}/audio-studio", json={
            "document": edited_document,
            "expected_revision": confirmed.json()["revision"],
        })
        self.assertEqual(edited.status_code, 200, edited.text)
        edited_record = edited.json()["document"]["dialogues"][0]
        self.assertEqual(edited_record["text_status"], "candidate")
        self.assertNotIn("text_confirmation", edited_record)
        self.assertEqual(len(record["text_confirmation"]["text_sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
