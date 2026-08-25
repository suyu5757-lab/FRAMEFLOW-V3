from __future__ import annotations

import asyncio
import base64
import hashlib
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

import server
from frameflow import upload_storage


UPLOAD_CHUNK = 1024 * 1024
PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
VIDEO_STUB = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"


class GuardedUpload:
    def __init__(self, payload: bytes, filename: str, fail_after_reads: int | None = None) -> None:
        self.payload = payload
        self.filename = filename
        self.fail_after_reads = fail_after_reads
        self.offset = 0
        self.read_sizes: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if size <= 0 or size > UPLOAD_CHUNK:
            raise AssertionError(f"upload read was not bounded: {size}")
        if self.fail_after_reads is not None and len(self.read_sizes) > self.fail_after_reads:
            raise OSError("synthetic interrupted upload")
        chunk = self.payload[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk


class UploadStreamingTests(unittest.TestCase):
    def test_stage_upload_hashes_and_writes_exact_multichunk_content(self) -> None:
        payload = b"streaming" + b"x" * (UPLOAD_CHUNK * 2 + 31)
        target = Path(__file__).parent / ".upload-streaming-fixtures"
        target.mkdir(exist_ok=True)
        destination = target / "stream-test-exact.bin"
        temporary = target / ".stream-test-exact.bin.stream-test.uploading"
        try:
            upload = GuardedUpload(payload, "exact.bin")
            with mock.patch.object(upload_storage.secrets, "token_hex", return_value="stream-test"):
                staged = asyncio.run(upload_storage.stage_upload(upload, destination, len(payload)))
            self.assertEqual(staged.size, len(payload))
            self.assertEqual(staged.sha256, hashlib.sha256(payload).hexdigest())
            self.assertEqual(staged.read_count, 4)
            self.assertEqual(staged.largest_read, UPLOAD_CHUNK)
            self.assertFalse(destination.exists())
            upload_storage.finalize_staged_upload(staged, destination)
            self.assertEqual(destination.read_bytes(), payload)
        finally:
            for candidate in (destination, temporary):
                if candidate.is_file():
                    candidate.unlink()
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()

    def test_stage_upload_removes_temp_file_on_midstream_failure(self) -> None:
        target = Path(__file__).parent / ".upload-streaming-fixtures"
        target.mkdir(exist_ok=True)
        destination = target / "stream-test-failure.bin"
        temporary = target / ".stream-test-failure.bin.stream-test.uploading"
        try:
            upload = GuardedUpload(b"x" * (UPLOAD_CHUNK * 2), "failure.bin", fail_after_reads=1)
            with mock.patch.object(upload_storage.secrets, "token_hex", return_value="stream-test"), self.assertRaises(OSError):
                asyncio.run(upload_storage.stage_upload(upload, destination, UPLOAD_CHUNK * 3))
            self.assertFalse(destination.exists())
            self.assertFalse(temporary.exists())
        finally:
            for candidate in (destination, temporary):
                if candidate.is_file():
                    candidate.unlink()
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()

    def test_stage_upload_rejects_oversize_and_removes_temp_file(self) -> None:
        target = Path(__file__).parent / ".upload-streaming-fixtures"
        target.mkdir(exist_ok=True)
        destination = target / "stream-test-oversize.bin"
        temporary = target / ".stream-test-oversize.bin.stream-test.uploading"
        try:
            upload = GuardedUpload(b"x" * (UPLOAD_CHUNK * 2 + 1), "oversize.bin")
            with mock.patch.object(upload_storage.secrets, "token_hex", return_value="stream-test"), self.assertRaises(upload_storage.UploadTooLarge):
                asyncio.run(upload_storage.stage_upload(upload, destination, UPLOAD_CHUNK * 2))
            self.assertFalse(destination.exists())
            self.assertFalse(temporary.exists())
        finally:
            for candidate in (destination, temporary):
                if candidate.is_file():
                    candidate.unlink()
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()

    def test_asset_upload_uses_bounded_reads_for_multichunk_payload(self) -> None:
        payload = b"\x89PNG\r\n\x1a\n" + b"x" * (UPLOAD_CHUNK * 2 + 17)
        upload = GuardedUpload(payload, "multi-chunk.png")
        target = Path(__file__).parent / ".upload-streaming-fixtures"
        target.mkdir(exist_ok=True)
        final_path = target / "stream-test-multi-chunk.png"
        temp_path = target / ".stream-test-multi-chunk.png.stream-test.uploading"
        request = SimpleNamespace()
        try:
            with mock.patch.object(server, "safe_project_path", return_value=target), \
                mock.patch.object(server, "db", return_value=object()), \
                mock.patch.object(server, "register_artifact", return_value={"id": "ART_TEST"}), \
                mock.patch.object(server, "artifact_url", return_value="/test-artifact"), \
                mock.patch.object(server.secrets, "token_hex", return_value="stream-test"), \
                mock.patch.object(upload_storage.secrets, "token_hex", return_value="stream-test"):
                result = asyncio.run(server.upload_asset(request, "PRJ_TEST", upload))

            self.assertEqual(result["artifact"]["id"], "ART_TEST")
            self.assertGreater(len(upload.read_sizes), 2)
            self.assertLessEqual(max(upload.read_sizes), UPLOAD_CHUNK)
            self.assertEqual(final_path.read_bytes(), payload)
        finally:
            for candidate in (final_path, temp_path):
                if candidate.is_file():
                    candidate.unlink()
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()

    def test_audio_helper_uses_shared_bounded_reader(self) -> None:
        payload = b"ID3" + b"a" * (UPLOAD_CHUNK + 19)
        upload = GuardedUpload(payload, "voice.mp3")
        target = Path(__file__).parent / ".upload-streaming-fixtures"
        target.mkdir(exist_ok=True)
        final_path = target / "voice-ref-stream-test.mp3"
        temporary = target / ".voice-ref-stream-test.mp3.stream-test.uploading"
        try:
            with mock.patch.object(server, "REFERENCE_AUDIO_DIR", target), \
                mock.patch.object(server, "artifact_url", return_value="/test-audio"), \
                mock.patch.object(server.secrets, "token_hex", return_value="stream-test"), \
                mock.patch.object(upload_storage.secrets, "token_hex", return_value="stream-test"):
                result = asyncio.run(server.import_audio(SimpleNamespace(), upload))
            self.assertEqual(result["sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(result["bytes"], len(payload))
            self.assertEqual(final_path.read_bytes(), payload)
            self.assertLessEqual(max(upload.read_sizes), UPLOAD_CHUNK)
        finally:
            for candidate in (final_path, temporary):
                if candidate.is_file():
                    candidate.unlink()
            if target.is_dir() and not any(target.iterdir()):
                target.rmdir()


class AssetIntakeStreamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-upload-{uuid.uuid4().hex}.db"
        self.db_patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.db_patch.start()
        self.context = TestClient(server.app, raise_server_exceptions=False)
        self.client = self.context.__enter__()
        created = self.client.post("/api/v2/projects", json={"name": "FF-P2-012 upload test", "ratio": "16:9", "duration": 8, "generator": "manual", "brief": "bounded upload regression"})
        self.assertEqual(created.status_code, 201, created.text)
        self.project_id = created.json()["document"]["id"]
        self.uploaded_paths: list[Path] = []

    def tearDown(self) -> None:
        for path in self.uploaded_paths:
            if path.is_file():
                path.unlink()
        self.context.__exit__(None, None, None)
        self.db_patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def _upload(self, filename: str, payload: bytes):
        return self.client.post(
            f"/api/v2/projects/{self.project_id}/asset-intake",
            files={"file": (filename, payload, "video/mp4" if filename.endswith(".mp4") else "image/png")},
            data={"asset_class": "video" if filename.endswith(".mp4") else "scene", "asset_role": "shot_video" if filename.endswith(".mp4") else "environment", "source_type": "test"},
        )

    def test_v3_intake_preserves_multichunk_video_bytes_hash_and_pending_authority(self) -> None:
        payload = VIDEO_STUB + b"v" * (UPLOAD_CHUNK * 2 + 29)
        response = self._upload("multi-chunk.mp4", payload)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        artifact = result["artifact"]
        path = Path(artifact["local_path"])
        self.uploaded_paths.append(path)
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(artifact["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(artifact["status"], "mapping_required")
        self.assertFalse(any(path.parent.glob("*.uploading")))
        with server.app.state.db.connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?", (self.project_id,)).fetchone()
            versions = connection.execute("SELECT COUNT(*) AS count FROM asset_versions WHERE project_id=?", (self.project_id,)).fetchone()
        self.assertEqual(row["count"], 1)
        self.assertEqual(versions["count"], 0)

    def test_v3_intake_accepts_valid_small_image(self) -> None:
        response = self._upload("small.png", PNG_1X1)
        self.assertEqual(response.status_code, 200, response.text)
        artifact = response.json()["artifact"]
        path = Path(artifact["local_path"])
        self.uploaded_paths.append(path)
        self.assertEqual(path.read_bytes(), PNG_1X1)
        self.assertEqual(artifact["sha256"], hashlib.sha256(PNG_1X1).hexdigest())
        self.assertEqual(artifact["status"], "mapping_required")

    def test_invalid_upload_leaves_no_artifact_or_file(self) -> None:
        response = self._upload("invalid.png", b"not a png")
        self.assertEqual(response.status_code, 422, response.text)
        with server.app.state.db.connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?", (self.project_id,)).fetchone()
        self.assertEqual(row["count"], 0)
        intake = Path(server.DATA_DIR) / "projects" / self.project_id / "artifacts" / "intake"
        self.assertFalse(intake.exists() and any(intake.iterdir()))

    def test_record_event_failure_removes_final_file_and_artifact(self) -> None:
        payload = PNG_1X1
        with mock.patch.object(server.asset_audit, "record_event", side_effect=RuntimeError("synthetic DB/event failure")):
            response = self._upload("failure.png", payload)
        self.assertEqual(response.status_code, 500, response.text)
        with server.app.state.db.connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?", (self.project_id,)).fetchone()
        self.assertEqual(row["count"], 0)
        intake = Path(server.DATA_DIR) / "projects" / self.project_id / "artifacts" / "intake"
        self.assertFalse(intake.exists() and any(intake.iterdir()))

    def test_oversize_stream_is_rejected_without_authority(self) -> None:
        payload = VIDEO_STUB + b"v" * (UPLOAD_CHUNK * 2 + 1)
        with mock.patch.object(server, "MAX_UPLOAD", UPLOAD_CHUNK * 2):
            response = self._upload("oversize.mp4", payload)
        self.assertEqual(response.status_code, 413, response.text)
        with server.app.state.db.connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?", (self.project_id,)).fetchone()
        self.assertEqual(row["count"], 0)


if __name__ == "__main__":
    unittest.main()
