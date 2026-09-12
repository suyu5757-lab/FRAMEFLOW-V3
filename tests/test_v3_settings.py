from __future__ import annotations

import uuid
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


class FrameflowV3SettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-settings-{uuid.uuid4().hex}.db"
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
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(self.db_path) + suffix)
            if path.is_file():
                path.unlink()

    def test_settings_overview_is_v3_only_and_redacted(self) -> None:
        response = self.client.get("/api/v2/settings")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["settings_version"], "3.0")
        self.assertEqual(payload["system"]["runtime"], "v3-only")
        self.assertGreaterEqual(len(payload["providers"]), 3)
        self.assertIn("orchestrator", payload["capabilities"])
        orchestrator = next(item for item in payload["bindings"] if item["capability"] == "orchestrator")
        self.assertEqual(orchestrator["provider_profile_id"], "opencode-default")
        self.assertEqual(orchestrator["model"], server.DEFAULT_ORCHESTRATOR_MODEL)
        self.assertNotIn("openai_configured", self.client.get("/api/health").json())
        self.assertNotIn("deepseek", {item["preset_id"] for item in payload["presets"]})
        self.assertNotIn("credential_ref", response.text)
        self.assertNotIn("api_key", response.text.lower())
        self.assertEqual(self.client.get("/api/provider-profiles").status_code, 410)

    def test_provider_lifecycle_uses_v2_settings_surface(self) -> None:
        created = self.client.post("/api/v2/settings/providers", json={
            "id": "settings-test-provider",
            "provider_type": "openai_compatible",
            "display_name": "设置测试接口",
            "base_url": "https://example.test/v1",
            "model_config": {},
            "capabilities": ["orchestrator"],
            "enabled": True,
        })
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["provider"]["id"], "settings-test-provider")
        updated = self.client.patch("/api/v2/settings/providers/settings-test-provider", json={"display_name": "设置测试接口（二）", "enabled": False})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertFalse(updated.json()["provider"]["enabled"])
        deleted = self.client.delete("/api/v2/settings/providers/settings-test-provider")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertFalse(any(item["id"] == "settings-test-provider" for item in deleted.json()["providers"]))

    def test_provider_delete_removes_profile_bindings_and_credential_but_keeps_presets(self) -> None:
        provider_id = "settings-delete-provider"
        created = self.client.post("/api/v2/settings/providers", json={
            "id": provider_id,
            "provider_type": "openai_compatible",
            "display_name": "待彻底删除接口",
            "base_url": "https://example.test/v1",
            "model_config": {},
            "capabilities": ["orchestrator"],
            "enabled": True,
        })
        self.assertEqual(created.status_code, 200, created.text)
        bound = self.client.put("/api/v2/settings/capability-bindings", json={
            "capability": "orchestrator",
            "provider_profile_id": provider_id,
            "model": None,
        })
        self.assertEqual(bound.status_code, 200, bound.text)

        with mock.patch.object(server, "delete_secret") as clear_secret:
            deleted = self.client.delete(f"/api/v2/settings/providers/{provider_id}")

        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["provider_id"], provider_id)
        self.assertEqual(deleted.json()["removed_capabilities"], ["orchestrator"])
        clear_secret.assert_called_once_with(f"provider:{provider_id}")
        settings = self.client.get("/api/v2/settings").json()
        self.assertFalse(any(item["id"] == provider_id for item in settings["providers"]))
        self.assertFalse(any(item["provider_profile_id"] == provider_id for item in settings["bindings"]))
        presets = self.client.get("/api/v2/settings/providers").json()["presets"]
        self.assertTrue(any(item["preset_id"] == "comfyui" for item in presets))
        readded = self.client.post("/api/v2/settings/providers/from-preset/comfyui", json={})
        self.assertEqual(readded.status_code, 200, readded.text)
        self.assertEqual(readded.json()["provider"]["id"], "comfyui-default")

    def test_seeded_provider_delete_is_persistent_and_preset_can_restore_it(self) -> None:
        provider_id = "minimax-default"
        with mock.patch.object(server, "delete_secret") as clear_secret:
            deleted = self.client.delete(f"/api/v2/settings/providers/{provider_id}")

        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertFalse(any(item["id"] == provider_id for item in deleted.json()["providers"]))
        self.assertEqual(
            {call.args[0] for call in clear_secret.call_args_list},
            {
                "provider:minimax-default:minimax:cn",
                "provider:minimax-default:minimax:global",
                "provider:minimax-default",
            },
        )
        reopened = server.Database(self.db_path)
        server.seed_defaults(reopened)
        with reopened.connect() as connection:
            self.assertIsNone(connection.execute("SELECT id FROM provider_profiles WHERE id=?", (provider_id,)).fetchone())
            tombstone = connection.execute("SELECT provider_id FROM provider_profile_tombstones WHERE provider_id=?", (provider_id,)).fetchone()
            self.assertIsNotNone(tombstone)

        presets = self.client.get("/api/v2/settings/providers").json()["presets"]
        minimax_preset = next(item for item in presets if item["preset_id"] == "minimax")
        self.assertEqual(minimax_preset["base_url"], "https://api.minimax.cn/v1")
        readded = self.client.post("/api/v2/settings/providers/from-preset/minimax", json={})
        self.assertEqual(readded.status_code, 200, readded.text)
        self.assertEqual(readded.json()["provider"]["id"], provider_id)
        reopened = server.Database(self.db_path)
        with reopened.connect() as connection:
            self.assertIsNone(connection.execute("SELECT provider_id FROM provider_profile_tombstones WHERE provider_id=?", (provider_id,)).fetchone())
        server.seed_defaults(reopened)
        with reopened.connect() as connection:
            self.assertIsNotNone(connection.execute("SELECT id FROM provider_profiles WHERE id=?", (provider_id,)).fetchone())

    def test_credential_write_import_clear_and_probe_never_echo_secret(self) -> None:
        secret = "sk-settings-secret-123456"
        with mock.patch.object(server, "set_secret") as write, mock.patch.object(server, "get_secret", return_value=secret), mock.patch.dict(server.os.environ, {"OPENAI_API_KEY": secret}, clear=False):
            response = self.client.post("/api/v2/settings/providers/openai-default/credential", json={"api_key": secret})
            self.assertEqual(response.status_code, 200, response.text)
            write.assert_called_once()
            self.assertNotIn(secret, response.text)
            imported = self.client.post("/api/v2/settings/providers/openai-default/credential/import", json={"environment_variable": "OPENAI_API_KEY"})
            self.assertEqual(imported.status_code, 200, imported.text)
            self.assertNotIn(secret, imported.text)
            with mock.patch.object(server, "delete_secret"):
                cleared = self.client.delete("/api/v2/settings/providers/openai-default/credential")
            self.assertEqual(cleared.status_code, 200, cleared.text)
            self.assertNotIn(secret, cleared.text)

        probe_result = {"ok": True, "models": ["settings-model"], "capabilities": ["orchestrator"], "model_readiness": {}, "checked_at": 1}
        with mock.patch.object(server, "probe_profile", new=mock.AsyncMock(return_value=probe_result)), mock.patch.object(server, "get_profile_secret", return_value="probe-secret"):
            probed = self.client.post("/api/v2/settings/providers/openai-default/probe")
        self.assertEqual(probed.status_code, 200, probed.text)
        self.assertEqual(probed.json()["probe"]["models"], ["settings-model"])
        self.assertNotIn("probe-secret", probed.text)
        models = self.client.get("/api/v2/settings/providers/openai-default/models")
        self.assertEqual(models.status_code, 200, models.text)
        self.assertEqual(models.json()["models"], ["settings-model"])

    def test_minimax_region_credentials_are_independent_and_probe_uses_active_region(self) -> None:
        stored: dict[str, str] = {}

        def read_secret(reference: str | None, environment_variable: str | None = None) -> str | None:
            return stored.get(str(reference))

        def write_secret(reference: str, value: str) -> None:
            stored[reference] = value

        with mock.patch.object(server, "get_secret", side_effect=read_secret), mock.patch.object(server, "set_secret", side_effect=write_secret):
            china = self.client.post("/api/v2/settings/providers/minimax-default/credential", json={"api_key": "cn-secret", "region": "cn"})
            global_region = self.client.post("/api/v2/settings/providers/minimax-default/credential", json={"api_key": "global-secret", "region": "global"})

        self.assertEqual(china.status_code, 200, china.text)
        self.assertEqual(global_region.status_code, 200, global_region.text)
        self.assertEqual(stored, {
            "provider:minimax-default:minimax:cn": "cn-secret",
            "provider:minimax-default:minimax:global": "global-secret",
        })
        self.assertNotIn("cn-secret", china.text)
        self.assertNotIn("global-secret", global_region.text)

        switched = self.client.patch("/api/v2/settings/providers/minimax-default", json={
            "base_url": "https://api.minimax.io/v1",
            "model_config": {"region": "global", "tts_model": "speech-2.8-hd"},
        })
        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()["provider"]["active_region"], "global")

        with mock.patch.object(server, "get_secret", side_effect=read_secret):
            active_profile = server.get_profile(server.Database(self.db_path), "minimax-default")
            self.assertEqual(server.get_profile_secret(active_profile), "global-secret")

        probe_result = {"ok": True, "models": ["speech-2.8-hd"], "capabilities": ["tts"], "model_readiness": {}, "checked_at": 1}
        with mock.patch.object(server, "get_secret", side_effect=read_secret), mock.patch.object(server, "probe_profile", new=mock.AsyncMock(return_value=probe_result)) as probe:
            probed = self.client.post("/api/v2/settings/providers/minimax-default/probe")
        self.assertEqual(probed.status_code, 200, probed.text)
        self.assertEqual(probe.await_args.args[1], "global-secret")
        self.assertEqual(probed.json()["probe"]["region"], "global")
        self.assertNotIn("global-secret", probed.text)

        switched_back = self.client.patch("/api/v2/settings/providers/minimax-default", json={
            "base_url": "https://api.minimax.cn/v1",
            "model_config": {"region": "cn", "tts_model": "speech-2.8-hd"},
        })
        self.assertEqual(switched_back.status_code, 200, switched_back.text)
        with mock.patch.object(server, "get_secret", side_effect=read_secret):
            settings = self.client.get("/api/v2/settings").json()
            minimax = next(item for item in settings["providers"] if item["id"] == "minimax-default")
            self.assertEqual(minimax["active_region"], "cn")
            self.assertTrue(minimax["credential_regions"]["cn"]["configured"])
            self.assertTrue(minimax["credential_regions"]["global"]["configured"])
            self.assertIsNone(minimax["last_probe"].get("ok"))

            switched_again = self.client.patch("/api/v2/settings/providers/minimax-default", json={
                "base_url": "https://api.minimax.io/v1",
                "model_config": {"region": "global", "tts_model": "speech-2.8-hd"},
            })
            self.assertEqual(switched_again.status_code, 200, switched_again.text)
            restored = self.client.get("/api/v2/settings").json()
            restored_minimax = next(item for item in restored["providers"] if item["id"] == "minimax-default")
            self.assertTrue(restored_minimax["last_probe"]["ok"])

    def test_failed_probe_is_persisted_as_the_latest_health_result(self) -> None:
        error = server.ProviderError("无法连接 Provider：测试连接失败", "connection", 502)
        with mock.patch.object(server, "get_profile_secret", return_value="probe-secret"), mock.patch.object(server, "probe_profile", new=mock.AsyncMock(side_effect=error)):
            probed = self.client.post("/api/v2/settings/providers/openai-default/probe")
        self.assertEqual(probed.status_code, 200, probed.text)
        payload = probed.json()["probe"]
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["models"], [])
        self.assertEqual(payload["error_kind"], "connection")
        self.assertGreater(payload["checked_at"], 0)
        settings = self.client.get("/api/v2/settings").json()
        provider = next(item for item in settings["providers"] if item["id"] == "openai-default")
        self.assertFalse(provider["last_probe"]["ok"])
        self.assertEqual(provider["last_probe"]["checked_at"], payload["checked_at"])

    def test_capability_binding_rejects_disabled_provider_and_accepts_v3_binding(self) -> None:
        accepted = self.client.put("/api/v2/settings/capability-bindings", json={"capability": "orchestrator", "provider_profile_id": "openai-default", "model": None})
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["binding"]["provider_profile_id"], "openai-default")

        created = self.client.post("/api/v2/settings/providers", json={
            "id": "disabled-settings-provider", "provider_type": "openai_compatible", "display_name": "停用接口", "base_url": "https://example.test/v1", "capabilities": ["orchestrator"], "enabled": False,
        })
        self.assertEqual(created.status_code, 200, created.text)
        rejected = self.client.put("/api/v2/settings/capability-bindings", json={"capability": "orchestrator", "provider_profile_id": "disabled-settings-provider", "model": None})
        self.assertEqual(rejected.status_code, 409, rejected.text)

    def test_auto_matching_repairs_disabled_route_and_accepts_official_opencode_go_model(self) -> None:
        disabled = self.client.patch("/api/v2/settings/providers/openai-default", json={"enabled": False})
        self.assertEqual(disabled.status_code, 200, disabled.text)
        updated = self.client.patch("/api/v2/settings/providers/opencode-default", json={
            "model_config": {"orchestrator_model": "opencode/gpt-5.6-luna", "thinking_strength": "max", "agent": "build"},
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["provider"]["model_config"]["thinking_strength"], "max")
        settings = self.client.get("/api/v2/settings").json()
        binding = next(item for item in settings["bindings"] if item["capability"] == "orchestrator")
        self.assertEqual((binding["provider_profile_id"], binding["model"]), ("opencode-default", "opencode/gpt-5.6-luna"))

    def test_preset_and_validation_boundaries(self) -> None:
        presets = self.client.get("/api/v2/settings/providers")
        self.assertEqual(presets.status_code, 200, presets.text)
        self.assertTrue(any(item["preset_id"] == "comfyui" for item in presets.json()["presets"]))
        added = self.client.post("/api/v2/settings/providers/from-preset/comfyui", json={})
        self.assertEqual(added.status_code, 200, added.text)
        invalid = self.client.post("/api/v2/settings/providers", json={
            "provider_type": "openai", "display_name": "错误地址", "base_url": "http://remote.example/v1", "capabilities": [],
        })
        self.assertEqual(invalid.status_code, 422, invalid.text)
        missing_preset = self.client.post("/api/v2/settings/providers/from-preset/missing", json={})
        self.assertEqual(missing_preset.status_code, 404, missing_preset.text)


if __name__ == "__main__":
    unittest.main()
