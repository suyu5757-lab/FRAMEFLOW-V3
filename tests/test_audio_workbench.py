from __future__ import annotations

import unittest

import server
from frameflow import asset_audit


class AudioWorkbenchCompatibilityTests(unittest.TestCase):
    def test_legacy_camel_case_audio_records_are_normalized(self) -> None:
        document = server._audio_studio_document({
            "audio": {
                "voices": [{"id": "V001", "sourceType": "preset", "consentStatus": "not-required"}],
                "dialogues": [{"id": "DLG001", "shotIds": ["SH008"], "text": "测试对白", "voiceId": "V001"}],
                "musicCues": [{"id": "CUE001", "shotIds": ["SH001"], "start": 0, "end": 4}],
                "ambience": [{"id": "AMB001", "shotIds": ["SH001"], "name": "雨声"}],
            }
        })
        self.assertEqual(document["voices"][0]["source_type"], "preset")
        self.assertEqual(document["dialogues"][0]["shot_ids"], ["SH008"])
        self.assertEqual(document["music_cues"][0]["shot_ids"], ["SH001"])
        self.assertEqual(document["music_cues"][0]["duration"], 4)
        self.assertEqual(document["sound_design"][0]["kind"], "ambience")

    def test_direct_audio_document_is_not_replaced_by_defaults(self) -> None:
        document = server._audio_studio_document({
            "version": 1,
            "selected_mode": "voices",
            "voices": [{"id": "V001", "name": "主角"}],
            "dialogues": [],
            "music_cues": [],
            "sound_design": [],
            "handoff": {"status": "ready", "approved_asset_ids": ["AUD001"]},
        })
        self.assertEqual(document["selected_mode"], "voices")
        self.assertEqual(document["voices"][0]["name"], "主角")
        self.assertEqual(document["handoff"]["status"], "ready")
        self.assertEqual(document["handoff"]["approved_asset_ids"], ["AUD001"])

    def test_audio_readiness_separates_file_qa_registration_and_production(self) -> None:
        candidate = asset_audit.asset_readiness({"assetClass": "audio", "artifactId": "ART001", "filePath": "voice.wav"})
        self.assertTrue(candidate["has_file"])
        self.assertFalse(candidate["registered_ready"])
        self.assertFalse(candidate["production_ready"])
        self.assertEqual(candidate["next_action"], "开始声音 QA")

        regenerated = asset_audit.asset_readiness({"assetClass": "audio", "artifactId": "ART002", "filePath": "voice-v2.wav", "qaDecision": "Approved", "regulatorRegistered": True, "status": "generated-pending-qa"})
        self.assertFalse(regenerated["registered_ready"])
        self.assertFalse(regenerated["production_ready"])
        self.assertEqual(regenerated["next_action"], "开始声音 QA")

        approved = asset_audit.asset_readiness({"assetClass": "audio", "artifactId": "ART001", "filePath": "voice.wav", "qaDecision": "Approved"})
        self.assertFalse(approved["production_ready"])
        self.assertEqual(approved["next_action"], "登记声音候选")

        registered = asset_audit.asset_readiness({"assetClass": "audio", "artifactId": "ART001", "filePath": "voice.wav", "qaDecision": "Approved", "regulatorRegistered": True, "authorizationStatus": "not-required"})
        self.assertTrue(registered["registered_ready"])
        self.assertTrue(registered["production_ready"])
        self.assertEqual(registered["qa_kind"], "audio")

    def test_audio_readiness_does_not_require_prompt_or_image_qa(self) -> None:
        result = asset_audit.asset_readiness({"assetClass": "music", "artifactId": "ART002", "filePath": "cue.wav", "qaDecision": "Approved", "regulatorRegistered": True, "authorizationStatus": "pending"})
        self.assertTrue(result["registered_ready"])
        self.assertFalse(result["production_ready"])
        self.assertIn("authorization", result["production_missing"])
        self.assertEqual(result["next_action"], "确认声音授权")
        self.assertNotIn("prompt", result["missing"])

    def test_audio_gates_require_explicit_approved_take_and_asset(self) -> None:
        document = server._audio_studio_document({
            "voices": [{"id": "V001", "name": "主角", "language": "zh-CN", "dialect": "普通话", "status": "approved"}],
            "auditions": [
                {"id": "AUD001", "voice_id": "V001", "condition": "neutral", "status": "approved", "artifact_id": "ART001"},
                {"id": "AUD002", "voice_id": "V001", "condition": "emotional", "status": "approved", "artifact_id": "ART002"},
                {"id": "AUD003", "voice_id": "V001", "condition": "pronunciation-stress", "status": "approved", "artifact_id": "ART003"},
            ],
            "dialogues": [{"id": "DLG001", "voice_id": "V001", "shot_ids": ["SH001"]}],
            "takes": [],
            "handoff": {"status": "provisional", "approved_asset_ids": []},
        })
        gates = server._audio_studio_gates(document, {"tts": {"ready": False}}, [])
        self.assertFalse(gates["handoff"]["allowed"])
        self.assertIn("DLG001:selected_approved_take", gates["dialogues"]["missing"])
        self.assertEqual(gates["tts_execution"]["status"], "external-execution-pending")


if __name__ == "__main__":
    unittest.main()
