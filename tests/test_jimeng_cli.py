import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from frameflow.jimeng_cli import _generation_args, _submit_id, validate_video_package, jimeng_get_task


class JimengCliTests(unittest.TestCase):
    PROFILE = {"provider_type": "jimeng_cli", "model_config": {"executable": "dreamina", "model_version": "seedance2.0fast"}}

    def test_text_to_video_uses_official_cli_flags(self) -> None:
        args = _generation_args({"prompt": "雨夜街道", "duration": 5, "aspect_ratio": "9:16", "resolution": "720p", "provider_model_or_endpoint": "seedance2.0"}, self.PROFILE)
        self.assertEqual(args, [
            "text2video", "--prompt=雨夜街道", "--duration=5", "--ratio=9:16",
            "--video_resolution=720p", "--model_version=seedance2.0",
        ])

    def test_text_only_rejects_image_only_model(self) -> None:
        issues = validate_video_package({"prompt": "推镜", "duration": 5, "resolution": "720p", "provider_model_or_endpoint": "seedance1.0fast"}, self.PROFILE)
        self.assertTrue(any("text2video" in issue for issue in issues))

    def test_seedance25_accepts_current_long_1080p_mode(self) -> None:
        issues = validate_video_package({"prompt": "推镜", "duration": 30, "resolution": "1080p", "provider_model_or_endpoint": "seedance2.5"}, self.PROFILE)
        self.assertEqual(issues, [])

    def test_remote_reference_is_rejected(self) -> None:
        issues = validate_video_package({"prompt": "推镜", "duration": 5, "resolution": "720p", "provider_model_or_endpoint": "seedance2.0", "reference_assets": ["https://example.com/frame.png"]}, self.PROFILE)
        self.assertTrue(any("本地文件路径" in issue for issue in issues))

    def test_standard_models_reject_unsupported_resolution(self) -> None:
        issues = validate_video_package({"prompt": "推镜", "duration": 5, "resolution": "480p", "provider_model_or_endpoint": "seedance2.0"}, self.PROFILE)
        self.assertTrue(any("仅支持 720p" in issue for issue in issues))

    def test_submit_id_and_downloaded_output_are_normalized(self) -> None:
        self.assertEqual(_submit_id('{"submit_id":"SUBMIT_123"}', {"submit_id": "SUBMIT_123"}), "SUBMIT_123")
        output_dir = Path(__file__).parent
        output = output_dir / "__jimeng_cli_test_result.mp4"
        try:
            output.write_bytes(b"mp4")
            with patch("frameflow.jimeng_cli.run_cli", new=AsyncMock(return_value=('{"gen_status":"success"}', ""))):
                result = asyncio.run(jimeng_get_task(self.PROFILE, "SUBMIT_123", output_dir))
        finally:
            if output.is_file():
                output.unlink()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(Path(result["output_path"]).name, "__jimeng_cli_test_result.mp4")


if __name__ == "__main__":
    unittest.main()
