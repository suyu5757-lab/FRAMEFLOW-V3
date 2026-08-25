from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import server


class SecurityBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db_path = Path(__file__).parent / f"test-security-{uuid.uuid4().hex}.db"
        self.patch = mock.patch.object(server, "DB_PATH", self.db_path)
        self.patch.start()
        self.context = TestClient(server.app)
        self.client = self.context.__enter__()

    def tearDown(self) -> None:
        self.context.__exit__(None, None, None)
        self.patch.stop()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.db_path) + suffix)
            if candidate.is_file():
                candidate.unlink()

    def test_loopback_security_headers_and_cross_origin_mutation_rejection(self) -> None:
        response = self.client.get("/api/v2/projects")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")
        rejected = self.client.post("/api/v2/projects", headers={"Origin": "https://evil.example"}, json={"name": "forbidden"})
        self.assertEqual(rejected.status_code, 403, rejected.text)
        same_origin_dynamic_port = self.client.post(
            "/api/v2/projects",
            headers={"Host": "testserver:8791", "Origin": "http://testserver:8791"},
            json={"name": "allowed dynamic origin"},
        )
        self.assertEqual(same_origin_dynamic_port.status_code, 201, same_origin_dynamic_port.text)
        host_rejected = self.client.get("/api/v2/projects", headers={"Host": "evil.example"})
        self.assertEqual(host_rejected.status_code, 400, host_rejected.text)

    def test_loopback_deployment_contract_rejects_non_loopback_bind(self) -> None:
        for host in ("127.0.0.1", "localhost", "::1"):
            self.assertEqual(server.classify_bind_host(host), "loopback")
            self.assertEqual(server.ensure_loopback_bind(host), host)
        for host in ("0.0.0.0", "192.168.1.20"):
            self.assertNotEqual(server.classify_bind_host(host), "loopback")
            with self.assertRaisesRegex(RuntimeError, "loopback-only"):
                server.ensure_loopback_bind(host)
        self.assertEqual(
            server.requested_bind_host(["uvicorn", "server:app", "--host", "0.0.0.0"], {}),
            "0.0.0.0",
        )


if __name__ == "__main__":
    unittest.main()
