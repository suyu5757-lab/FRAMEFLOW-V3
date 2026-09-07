from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow.provider_adapters import adapter_for_profile, provider_contract
from frameflow.providers import (
    MINIMAX_DEFAULT_TTS_MODEL,
    MINIMAX_DEFAULT_VOICE_ID,
    minimax_probe,
    minimax_speech,
    minimax_tts_payload,
)


class MiniMaxProviderUnitTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.profile = {
            "id": "minimax-test",
            "provider_type": "minimax",
            "display_name": "MiniMax TTS",
            "base_url": "https://api.minimax.cn/v1",
            "model_config": {"tts_model": MINIMAX_DEFAULT_TTS_MODEL, "voice_id": MINIMAX_DEFAULT_VOICE_ID, "language_boost": "Chinese"},
            "capabilities": ["tts"],
            "enabled": True,
        }

    def test_provider_contract_reserves_tts_for_minimax(self) -> None:
        minimax = provider_contract(self.profile)
        openai = provider_contract({"provider_type": "openai", "model_config": {}, "capabilities": []})
        self.assertEqual(minimax["capabilities"], ["tts"])
        self.assertNotIn("tts", openai["capabilities"])

    def test_minimax_request_payload_uses_provider_native_fields(self) -> None:
        payload = minimax_tts_payload(self.profile, {
            "text": "请停一下<#0.4#>再继续。",
            "model": "speech-2.8-hd",
            "voice": "female-shaonv",
            "format": "wav",
            "speed": 1.1,
            "volume": 0.9,
            "pitch": -1,
            "emotion": "calm",
            "language_boost": "Chinese",
        })
        self.assertEqual(payload["text"], "请停一下<#0.4#>再继续。")
        self.assertEqual(payload["voice_setting"]["voice_id"], "female-shaonv")
        self.assertEqual(payload["voice_setting"]["vol"], 0.9)
        self.assertEqual(payload["voice_setting"]["pitch"], -1)
        self.assertEqual(payload["audio_setting"]["format"], "wav")
        self.assertEqual(payload["output_format"], "hex")

    async def test_minimax_speech_decodes_hex_and_keeps_provider_metadata(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(return_value={
            "data": {"audio": "52494646", "status": 2},
            "trace_id": "trace-test",
            "extra_info": {"audio_length": 4},
        })) as request:
            audio, metadata = await minimax_speech(self.profile, "secret-not-returned", {"model": "speech-2.8-hd", "text": "测试"})
        self.assertEqual(audio, b"RIFF")
        self.assertEqual(metadata["trace_id"], "trace-test")
        request.assert_awaited_once()
        self.assertNotIn("secret-not-returned", repr(metadata))

    async def test_minimax_probe_returns_models_and_sanitized_voice_directory(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(return_value={
            "system_voice": [{"voice_id": "male-qn-qingse", "voice_name": "青涩男声", "description": "系统音色"}],
            "voice_cloning": [{"voice_id": "clone-001", "voice_name": "克隆音色", "token": "must-not-leak"}],
            "voice_generation": [],
            "base_resp": {"status_code": 0},
        })):
            result = await minimax_probe(self.profile, "secret-not-returned")
        self.assertTrue(result["ok"])
        self.assertIn("speech-2.8-hd", result["models"])
        self.assertEqual(result["capabilities"], ["tts"])
        self.assertEqual(result["voices"][0]["voice_id"], "male-qn-qingse")
        self.assertNotIn("token", repr(result["voices"]))

    async def test_minimax_adapter_submits_audio_as_normalized_output(self) -> None:
        adapter = adapter_for_profile(self.profile)
        with mock.patch("frameflow.provider_adapters.minimax_speech", new=mock.AsyncMock(return_value=(b"RIFF", {"trace_id": "trace"}))) as speech:
            result = await adapter.submit("tts", {"text": "测试", "model": "speech-2.8-hd", "voice": "male-qn-qingse", "format": "wav"}, "secret-not-returned")
        self.assertTrue(result["has_output"])
        self.assertEqual(result["provider_type"], "minimax")
        self.assertEqual(result["provider_metadata"]["trace_id"], "trace")
        speech.assert_awaited_once()


class MiniMaxTtsRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="frameflow-minimax-route-")
        self.db_path = Path(self.temp_dir.name) / "minimax-test.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.secret_patch = mock.patch.object(server, "get_secret", return_value=None)
        self.secret_patch.start()
        self.client_context = TestClient(server.app)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        self.secret_patch.stop()
        self.db_patch.stop()
        self.temp_dir.cleanup()

    def test_settings_default_and_binding_are_minimax_only(self) -> None:
        settings = self.client.get("/api/v2/settings")
        self.assertEqual(settings.status_code, 200, settings.text)
        payload = settings.json()
        minimax = next(item for item in payload["providers"] if item["provider_type"] == "minimax")
        self.assertEqual(minimax["contract"]["capabilities"], ["tts"])
        tts_binding = next(item for item in payload["bindings"] if item["capability"] == "tts")
        self.assertEqual(tts_binding["provider_profile_id"], "minimax-default")
        self.assertTrue(any(item["preset_id"] == "minimax" for item in payload["presets"]))

        rejected = self.client.put("/api/v2/settings/capability-bindings", json={
            "capability": "tts", "provider_profile_id": "openai-default", "model": None,
        })
        self.assertEqual(rejected.status_code, 409, rejected.text)

    def test_speech_route_calls_minimax_and_registers_source(self) -> None:
        project_id = f"PRJ_MINIMAX_{uuid.uuid4().hex[:8]}"
        project = {
            "id": project_id,
            "name": "MiniMax TTS route test",
            "ratio": "16:9",
            "duration": 10,
            "generator": "Seedance 2.5",
            "assets": [{"id": "AUD001", "name": "对白资产", "skill": "audio", "assetClass": "audio", "assetRole": "dialogue", "status": "missing", "assetMetadata": {"asset_class": "audio"}}],
            "audio": {"voices": [{"id": "V001", "source_type": "preset", "provider_voice_id": MINIMAX_DEFAULT_VOICE_ID, "consent_status": "not-required"}], "dialogues": [], "auditions": [], "takes": [], "handoff": {"status": "provisional", "approved_asset_ids": []}},
        }
        with tempfile.TemporaryDirectory(prefix="frameflow-minimax-output-") as output_root:
            output_dir = Path(output_root)
            resource_dir = output_dir / "resource"
            with mock.patch.object(server, "DATA_DIR", resource_dir), mock.patch.object(server, "GENERATED_DIR", output_dir / "generated"), mock.patch.object(server, "GENERATED_AUDIO_DIR", output_dir / "generated" / "audio"), mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "minimax_speech", new=mock.AsyncMock(return_value=(b"RIFF", {"trace_id": "trace-route", "extra_info": {}}))) as speech:
                created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": project})
                self.assertEqual(created.status_code, 200, created.text)
                response = self.client.post(f"/api/v2/projects/{project_id}/audio/tts", json={"text": "测试 MiniMax", "voice": MINIMAX_DEFAULT_VOICE_ID, "voice_id": "V001", "dialogue_id": "DLG001", "logical_asset_id": "AUD001", "confirmed": True})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["provider_type"], "minimax")
        self.assertEqual(payload["source_type"], "minimax-tts")
        self.assertEqual(payload["model"], MINIMAX_DEFAULT_TTS_MODEL)
        self.assertEqual(payload["voice"], MINIMAX_DEFAULT_VOICE_ID)
        speech.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
