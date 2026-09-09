from __future__ import annotations

import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import httpx
from fastapi.testclient import TestClient

import server
from frameflow.provider_adapters import adapter_for_profile, provider_contract
from frameflow.schemas import SpeechGenerate, VoiceDesignGenerate
from frameflow.providers import (
    MINIMAX_DEFAULT_TTS_MODEL,
    MINIMAX_DEFAULT_VOICE_ID,
    MINIMAX_TTS_MAX_TEXT_CHARS,
    ProviderError,
    compile_minimax_provider_text,
    language_boost_for_locale,
    minimax_probe,
    minimax_speech,
    minimax_tts_payload,
    minimax_voice_design,
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

    def test_speech_schema_uses_minimax_limits_and_defaults(self) -> None:
        request = SpeechGenerate(text="日语测试", confirmed=True)
        self.assertEqual(request.model, "speech-2.8-hd")
        self.assertEqual(request.voice, "")
        self.assertEqual(request.format, "wav")
        self.assertEqual(request.speed, 1.0)
        with self.assertRaises(ValueError):
            SpeechGenerate(text="a" * 10000, confirmed=True)

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

    def test_japanese_locale_wins_over_legacy_profile_language_and_compiles_provider_text(self) -> None:
        payload = minimax_tts_payload(self.profile, {
            "text": "先輩、今日の放課後、一緒に帰りませんか？",
            "model": "speech-2.8-hd",
            "voice": "Japanese_SportyStudent",
            "locale": "ja-JP",
            "language": "Japanese",
            "pause_plan": [{"after": "放課後、", "seconds": 0.25}],
            "emotion": "",
        })
        self.assertEqual(language_boost_for_locale("ja-JP"), "Japanese")
        self.assertEqual(payload["language_boost"], "Japanese")
        self.assertEqual(payload["text"], "先輩、今日の放課後、<#0.25#>一緒に帰りませんか？")
        self.assertNotIn("emotion", payload["voice_setting"])

    def test_explicit_auto_language_does_not_inherit_legacy_profile_default(self) -> None:
        payload = minimax_tts_payload(self.profile, {
            "text": "先輩、今日の放課後、一緒に帰りませんか？",
            "language_boost": None,
        })
        self.assertNotIn("language_boost", payload)

    def test_missing_language_does_not_inherit_legacy_chinese_profile_default(self) -> None:
        payload = minimax_tts_payload(self.profile, {"text": "未指定语言的短句"})
        self.assertNotIn("language_boost", payload)

    def test_minimax_text_boundary_and_pause_rules_are_validated(self) -> None:
        self.assertEqual(len("a" * MINIMAX_TTS_MAX_TEXT_CHARS), 9999)
        minimax_tts_payload(self.profile, {"text": "a" * MINIMAX_TTS_MAX_TEXT_CHARS})
        with self.assertRaises(ProviderError):
            minimax_tts_payload(self.profile, {"text": "a" * (MINIMAX_TTS_MAX_TEXT_CHARS + 1)})
        with self.assertRaises(ProviderError):
            minimax_tts_payload(self.profile, {"text": "<#0.3#>开头不合法"})
        self.assertEqual(compile_minimax_provider_text("一段话，继续", [{"after": "一段话", "seconds": 0.2}]), "一段话<#0.2#>，继续")

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

    async def test_billable_tts_transport_failure_is_execution_unknown_without_retry(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(side_effect=httpx.ReadTimeout("upstream"))) as request:
            with self.assertRaises(ProviderError) as context:
                await minimax_speech(self.profile, "secret-not-returned", {"model": "speech-2.8-hd", "text": "测试"})
        self.assertEqual(context.exception.kind, "execution-unknown")
        request.assert_awaited_once()
        self.assertFalse(server.provider_error_retryable(504, context.exception.kind))

    def test_voice_design_schema_keeps_preview_separate_from_tts(self) -> None:
        request = VoiceDesignGenerate(
            prompt="A warm, clear young adult voice with natural conversational energy.",
            preview_text="先輩、今日の放課後、一緒に帰りませんか？",
            provider_region="global",
            expected_revision=1,
            confirmed=True,
        )
        self.assertEqual(request.provider_region, "global")
        self.assertLessEqual(len(request.preview_text), 500)
        with self.assertRaises(ValueError):
            VoiceDesignGenerate(prompt="voice", preview_text="a" * 501, expected_revision=1, confirmed=True)

    async def test_voice_design_decodes_trial_audio_and_keeps_voice_id(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(return_value={
            "voice_id": "custom-voice-001",
            "trial_audio": "52494646",
            "base_resp": {"status_code": 0},
        })) as request:
            audio, metadata = await minimax_voice_design(
                self.profile,
                "secret-not-returned",
                "A soft, bright young student voice with natural conversational energy.",
                "先輩、今日の放課後、一緒に帰りませんか？",
            )
        self.assertEqual(audio, b"RIFF")
        self.assertEqual(metadata["voice_id"], "custom-voice-001")
        request.assert_awaited_once()
        self.assertNotIn("secret-not-returned", repr(metadata))

    async def test_voice_design_transport_failure_is_execution_unknown_without_retry(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(side_effect=httpx.ReadTimeout("upstream"))) as request:
            with self.assertRaises(ProviderError) as context:
                await minimax_voice_design(self.profile, "secret-not-returned", "voice", "试听文本")
        self.assertEqual(context.exception.kind, "execution-unknown")
        request.assert_awaited_once()

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
        self.assertEqual(result["voices"][0]["name"], "青涩男声")
        self.assertNotIn("token", repr(result["voices"]))

    async def test_minimax_http_200_invalid_api_key_is_auth_error(self) -> None:
        with mock.patch("frameflow.providers.request_json", new=mock.AsyncMock(return_value={
            "base_resp": {"status_code": 1004, "status_msg": "invalid api key"},
        })):
            with self.assertRaises(ProviderError) as context:
                await minimax_probe(self.profile, "secret-not-returned")
        self.assertEqual(context.exception.kind, "auth")

    async def test_minimax_probe_uses_documented_backup_on_transport_failure(self) -> None:
        success = {"system_voice": [], "voice_cloning": [], "voice_generation": [], "base_resp": {"status_code": 0}}
        request = mock.AsyncMock(side_effect=[httpx.ConnectError("offline"), success])
        with mock.patch("frameflow.providers.request_json", new=request):
            result = await minimax_probe(self.profile, "secret-not-returned")
        self.assertTrue(result["ok"])
        self.assertEqual(request.await_count, 2)
        self.assertEqual(request.await_args_list[1].args[1], "https://api-bj.minimaxi.com/v1/get_voice")

    async def test_global_probe_stays_in_global_region(self) -> None:
        profile = {**self.profile, "base_url": "https://api.minimax.io/v1", "model_config": {"region": "global"}}
        success = {"system_voice": [], "voice_cloning": [], "voice_generation": [], "base_resp": {"status_code": 0}}
        request = mock.AsyncMock(side_effect=[httpx.ConnectError("offline"), success])
        with mock.patch("frameflow.providers.request_json", new=request):
            result = await minimax_probe(profile, "secret-not-returned")
        self.assertEqual(result["region"], "global")
        self.assertEqual(request.await_args_list[1].args[1], "https://api-uw.minimax.io/v1/get_voice")

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
        self.assertEqual(minimax["model_config"].get("language_boost"), None)
        self.assertEqual(minimax["model_config"].get("region"), "cn")
        self.assertEqual(minimax["contract"]["input_limits"]["tts"]["max_text_chars"], 9999)

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
            with mock.patch.object(server, "DATA_DIR", resource_dir), mock.patch.object(server, "GENERATED_DIR", output_dir / "generated"), mock.patch.object(server, "GENERATED_AUDIO_DIR", output_dir / "generated" / "audio"), mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "_minimax_voice_catalog_payload", return_value={"status": "live", "voices": [{"voice_id": MINIMAX_DEFAULT_VOICE_ID, "source": "system"}]}), mock.patch.object(server, "minimax_speech", new=mock.AsyncMock(return_value=(b"RIFF", {"trace_id": "trace-route", "extra_info": {}}))) as speech:
                created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": project})
                self.assertEqual(created.status_code, 200, created.text)
                response = self.client.post(f"/api/v2/projects/{project_id}/audio/tts", json={"text": "测试 MiniMax", "voice": MINIMAX_DEFAULT_VOICE_ID, "voice_id": "V001", "dialogue_id": "DLG001", "logical_asset_id": "AUD001", "pause_plan": [{"after": "测试", "seconds": 0.2}], "confirmed": True})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["provider_type"], "minimax")
        self.assertEqual(payload["source_type"], "minimax-tts")
        self.assertEqual(payload["model"], MINIMAX_DEFAULT_TTS_MODEL)
        self.assertEqual(payload["voice"], MINIMAX_DEFAULT_VOICE_ID)
        self.assertEqual(speech.await_args.args[2]["text"], "测试<#0.2#> MiniMax")
        speech.assert_awaited_once()

    def test_voice_design_preview_is_saved_as_unadopted_candidate(self) -> None:
        project_id = f"PRJ_VOICE_DESIGN_{uuid.uuid4().hex[:8]}"
        project = {
            "id": project_id,
            "name": "MiniMax Voice Design route test",
            "ratio": "16:9",
            "duration": 10,
            "generator": "Seedance 2.5",
            "assets": [],
            "audio": {"voices": [], "dialogues": [], "auditions": [], "takes": [], "handoff": {"status": "provisional", "approved_asset_ids": []}},
        }
        with tempfile.TemporaryDirectory(prefix="frameflow-voice-design-output-") as output_root:
            output_dir = Path(output_root)
            resource_dir = output_dir / "resource"
            with mock.patch.object(server, "DATA_DIR", resource_dir), mock.patch.object(server, "GENERATED_DIR", output_dir / "generated"), mock.patch.object(server, "GENERATED_AUDIO_DIR", output_dir / "generated" / "audio"), mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "_minimax_secret", return_value="provider-secret"), mock.patch.object(server, "minimax_voice_design", new=mock.AsyncMock(return_value=(b"ID3", {"voice_id": "custom-voice-001"}))) as design:
                created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": project})
                self.assertEqual(created.status_code, 200, created.text)
                expected_revision = created.json()["revision"]
                response = self.client.post(f"/api/v2/projects/{project_id}/audio/voice-design", json={
                    "prompt": "A clear, soft young student voice with lively but natural energy.",
                    "preview_text": "先輩、今日の放課後、一緒に帰りませんか？",
                    "provider_profile_id": "minimax-default",
                    "provider_region": "global",
                    "locale": "ja-JP",
                    "language": "Japanese",
                    "character_id": "C001",
                    "expected_revision": expected_revision,
                    "confirmed": True,
                })
                self.assertEqual(response.status_code, 200, response.text)
                payload = response.json()
                self.assertEqual(payload["execution_status"], "candidate")
                self.assertEqual(payload["candidate"]["provider_voice_id"], "custom-voice-001")
                self.assertEqual(payload["candidate"]["status"], "candidate")
                self.assertEqual(payload["candidate"]["provider_region"], "global")
                self.assertEqual(len(payload["document"]["voice_design_candidates"]), 1)
                self.assertEqual(payload["document"]["voices"], [])
                self.assertIn("7 天", payload["candidate"]["retention_notice"])
                replay = self.client.post(f"/api/v2/projects/{project_id}/audio/voice-design", json={
                    "prompt": "A clear, soft young student voice with lively but natural energy.",
                    "preview_text": "先輩、今日の放課後、一緒に帰りませんか？",
                    "provider_profile_id": "minimax-default",
                    "provider_region": "global",
                    "locale": "ja-JP",
                    "language": "Japanese",
                    "character_id": "C001",
                    "expected_revision": payload["revision"],
                    "confirmed": True,
                })
                self.assertEqual(replay.status_code, 200, replay.text)
                self.assertTrue(replay.json()["idempotent_reuse"])
                design.assert_awaited_once()

    def test_voice_design_requires_explicit_cost_confirmation(self) -> None:
        project_id = f"PRJ_VOICE_DESIGN_GATE_{uuid.uuid4().hex[:8]}"
        created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": {"id": project_id, "name": "Voice Design gate", "ratio": "16:9", "duration": 10, "generator": "Seedance 2.5", "assets": [], "audio": {}}})
        self.assertEqual(created.status_code, 200, created.text)
        with mock.patch.object(server, "minimax_voice_design", new=mock.AsyncMock()) as design:
            response = self.client.post(f"/api/v2/projects/{project_id}/audio/voice-design", json={
                "prompt": "voice",
                "preview_text": "试听文本",
                "expected_revision": created.json()["revision"],
                "confirmed": False,
            })
        self.assertEqual(response.status_code, 409, response.text)
        design.assert_not_awaited()

    def test_system_voice_catalog_exposes_documented_candidates_without_claiming_live(self) -> None:
        response = self.client.get("/api/v2/providers/minimax-default/voices")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["catalog_source"], "documented")
        self.assertIn("Japanese_SportyStudent", {item["voice_id"] for item in payload["voices"]})

    def test_system_voice_catalog_can_read_the_non_active_region_without_switching_provider(self) -> None:
        response = self.client.get("/api/v2/providers/minimax-default/voices?region=global")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["region"], "global")
        self.assertEqual(response.json()["base_url"], "https://api.minimax.io/v1")

    def test_audio_studio_exposes_both_minimax_region_routes(self) -> None:
        project_id = f"PRJ_MINIMAX_ROUTES_{uuid.uuid4().hex[:8]}"
        project = {"id": project_id, "name": "MiniMax region routes", "ratio": "16:9", "duration": 10, "generator": "Seedance 2.5", "assets": [], "audio": {}}
        created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": project})
        self.assertEqual(created.status_code, 200, created.text)
        response = self.client.get(f"/api/v2/projects/{project_id}/audio-studio")
        self.assertEqual(response.status_code, 200, response.text)
        routes = response.json()["tts_routes"]
        self.assertEqual({item["region"] for item in routes}, {"cn", "global"})
        self.assertEqual(response.json()["default_tts_route_id"], "minimax-default:cn")

    def test_project_speech_can_use_a_configured_non_active_region(self) -> None:
        project_id = f"PRJ_MINIMAX_GLOBAL_{uuid.uuid4().hex[:8]}"
        project = {
            "id": project_id,
            "name": "MiniMax global route test",
            "ratio": "16:9",
            "duration": 10,
            "generator": "Seedance 2.5",
            "assets": [{"id": "AUD001", "name": "对白资产", "skill": "audio", "assetClass": "audio", "assetRole": "dialogue", "status": "missing", "assetMetadata": {"asset_class": "audio"}}],
            "audio": {"voices": [{"id": "V001", "source_type": "preset", "provider_voice_id": MINIMAX_DEFAULT_VOICE_ID, "provider_profile_id": "minimax-default", "provider_region": "global", "consent_status": "not-required"}], "dialogues": [], "auditions": [], "takes": [], "handoff": {"status": "provisional", "approved_asset_ids": []}},
        }
        with tempfile.TemporaryDirectory(prefix="frameflow-minimax-global-output-") as output_root:
            output_dir = Path(output_root)
            resource_dir = output_dir / "resource"
            with mock.patch.object(server, "DATA_DIR", resource_dir), mock.patch.object(server, "GENERATED_DIR", output_dir / "generated"), mock.patch.object(server, "GENERATED_AUDIO_DIR", output_dir / "generated" / "audio"), mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "_minimax_voice_catalog_payload", return_value={"status": "live", "region": "global", "voices": [{"voice_id": MINIMAX_DEFAULT_VOICE_ID, "source": "system"}]}), mock.patch.object(server, "minimax_speech", new=mock.AsyncMock(return_value=(b"RIFF", {"trace_id": "trace-global", "extra_info": {}}))) as speech:
                created = self.client.put(f"/api/v2/projects/{project_id}", json={"document": project})
                self.assertEqual(created.status_code, 200, created.text)
                response = self.client.post(f"/api/v2/projects/{project_id}/audio/tts", json={"text": "Global MiniMax", "voice": MINIMAX_DEFAULT_VOICE_ID, "voice_id": "V001", "dialogue_id": "DLG001", "logical_asset_id": "AUD001", "provider_region": "global", "confirmed": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(speech.await_args.args[0]["base_url"], "https://api.minimax.io/v1")
        self.assertEqual(response.json()["provider_region"], "global")

    def test_probe_transport_failure_returns_failed_probe_instead_of_500(self) -> None:
        with mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "probe_profile", new=mock.AsyncMock(side_effect=httpx.ConnectError("offline"))):
            response = self.client.post("/api/v2/settings/providers/minimax-default/probe")
        self.assertEqual(response.status_code, 200, response.text)
        probe = response.json()["probe"]
        self.assertFalse(probe["ok"])
        self.assertEqual(probe["error_kind"], "connection")
        self.assertNotIn("provider-secret", response.text)

    def test_compatibility_probe_endpoint_uses_same_failure_classification(self) -> None:
        with mock.patch.object(server, "get_profile_secret", return_value="provider-secret"), mock.patch.object(server, "probe_profile", new=mock.AsyncMock(side_effect=ProviderError("MiniMax API：invalid api key", "auth", 401))):
            response = self.client.post("/api/v2/providers/minimax-default/probe")
        self.assertEqual(response.status_code, 200, response.text)
        probe = response.json()["probe"]
        self.assertFalse(probe["ok"])
        self.assertEqual(probe["error_kind"], "auth")


if __name__ == "__main__":
    unittest.main()
