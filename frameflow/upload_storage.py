"""Bounded, incremental storage for user-provided multipart uploads."""

from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


UPLOAD_CHUNK_SIZE = 1024 * 1024
UPLOAD_INSPECTION_SIZE = UPLOAD_CHUNK_SIZE


class AsyncUploadReader(Protocol):
    async def read(self, size: int = -1) -> bytes:
        ...


class UploadTooLarge(ValueError):
    def __init__(self, received: int, maximum: int) -> None:
        self.received = received
        self.maximum = maximum
        super().__init__(f"上传内容超过大小限制（{maximum} 字节）。")


@dataclass(frozen=True)
class StagedUpload:
    temp_path: Path
    size: int
    sha256: str
    inspection: bytes
    read_count: int
    largest_read: int


def _temporary_path(destination: Path) -> Path:
    return destination.with_name(f".{destination.name}.{secrets.token_hex(8)}.uploading")


async def stage_upload(upload: AsyncUploadReader, destination: Path, maximum: int) -> StagedUpload:
    """Read an upload in bounded chunks into a same-directory temporary file."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_path(destination)
    digest = hashlib.sha256()
    inspection = bytearray()
    total = 0
    read_count = 0
    largest_read = 0
    try:
        with temporary.open("wb") as handle:
            while True:
                chunk = await upload.read(UPLOAD_CHUNK_SIZE)
                read_count += 1
                largest_read = max(largest_read, len(chunk))
                if not chunk:
                    break
                total += len(chunk)
                if total > maximum:
                    raise UploadTooLarge(total, maximum)
                digest.update(chunk)
                if len(inspection) < UPLOAD_INSPECTION_SIZE:
                    remaining = UPLOAD_INSPECTION_SIZE - len(inspection)
                    inspection.extend(chunk[:remaining])
                handle.write(chunk)
        return StagedUpload(temporary, total, digest.hexdigest(), bytes(inspection), read_count, largest_read)
    except BaseException:
        cleanup_staged_upload(StagedUpload(temporary, total, "", b"", read_count, largest_read))
        raise


def finalize_staged_upload(staged: StagedUpload, destination: Path) -> None:
    """Atomically move a completed same-directory upload into its final path."""
    os.replace(staged.temp_path, destination)


def cleanup_staged_upload(staged: StagedUpload) -> None:
    try:
        staged.temp_path.unlink(missing_ok=True)
    except OSError:
        pass


def cleanup_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
