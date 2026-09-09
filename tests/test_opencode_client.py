from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from frameflow.opencode_client import normalize_opencode_providers, opencode_structured, probe_opencode, split_model_ref


class OpenCodeClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.profile = {
            "base_url": "http://127.0.0.1:4096", "provider_type": "opencode",
            "model_config": {"server_username": "opencode", "agent": "build"},
        }

    def test_normalize_provider_catalog_preserves_two_level_identity(self) -> None:
        catalog, connected = normalize_opencode_providers({
            "connected": ["anthropic"],
            "all": [
                {"id": "openrouter", "name": "OpenRouter", "models": {"anthropic/claude-3.7": {"name": "Claude 3.7"}}},
                {"id": "anthropic", "name": "Anthropic", "models": {"claude-sonnet-4-5": {"name": "Claude Sonnet 4.5"}}},
            ],
        })
        self.assertEqual(connected, ["anthropic"])
        self.assertEqual(catalog[0]["id"], "anthropic/claude-sonnet-4-5")
        self.assertTrue(catalog[0]["connected"])
        self.assertNotIn("openrouter/anthropic/claude-3.7", {item["id"] for item in catalog})
        self.assertEqual(split_model_ref("openrouter/anthropic/claude-3.7"), ("openrouter", "anthropic/claude-3.7"))

    async def test_probe_reads_health_and_provider_catalog(self) -> None:
        async def fake_request(profile, method, path, password="", **kwargs):
            if path == "/global/health":
                return {"healthy": True, "version": "1.2.3"}
            return {"connected": ["opencode-go"], "all": [{"id": "opencode-go", "name": "OpenCode Go Plan", "models": {"gpt-5.1-codex": {"name": "GPT 5.1 Codex"}}}]}
        with mock.patch("frameflow.opencode_client.opencode_request_json", new=fake_request):
            result = await probe_opencode(self.profile)
        self.assertTrue(result["ok"])
        self.assertEqual(result["models"], ["opencode-go/gpt-5.1-codex"])
        self.assertEqual(result["server_version"], "1.2.3")

    async def test_structured_prompt_passes_provider_and_model_separately(self) -> None:
        calls = []
        self.profile["model_config"]["thinking_strength"] = "max"
        self.profile["model_config"]["directory"] = "/tmp/frameflow-opencode-test"
        async def fake_request(profile, method, path, password="", **kwargs):
            calls.append((method, path, kwargs.get("json"), kwargs.get("params")))
            if path == "/session":
                return {"id": "SES_TEST"}
            return {"info": {"id": "MSG_TEST", "structured_output": {"reply": "ok"}}, "parts": []}
        with mock.patch("frameflow.opencode_client.opencode_request_json", new=fake_request):
            result = await opencode_structured(self.profile, "", "openrouter/anthropic/claude-3.7", "system", "prompt", {"type": "object"})
        session_body = calls[0][2]
        message_body = calls[1][2]
        self.assertEqual(session_body["model"], {"id": "anthropic/claude-3.7", "providerID": "openrouter", "variant": "max"})
        self.assertEqual(session_body["agent"], "build")
        self.assertNotIn("model", message_body)
        self.assertNotIn("agent", message_body)
        self.assertEqual(message_body["format"], {"type": "json_schema", "schema": {"type": "object"}})
        self.assertNotIn("retryCount", message_body["format"])
        expected_directory = str(Path("/tmp/frameflow-opencode-test").resolve())
        self.assertEqual(calls[0][3], {"directory": expected_directory})
        self.assertEqual(calls[1][3], {"directory": expected_directory})
        self.assertEqual(result["opencode_session_id"], "SES_TEST")

    def test_structured_result_accepts_server_field_name(self) -> None:
        from frameflow.opencode_client import _structured_result
        self.assertEqual(
            _structured_result({"info": {"structured": {"reply": "ok"}}, "parts": []}),
            {"reply": "ok"},
        )


if __name__ == "__main__":
    unittest.main()
