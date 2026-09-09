"""Local attachment storage and bounded document extraction for the Agent.

Attachments are ordinary project references, not a second asset pipeline.  The
database stores metadata and analysis state while the original bytes remain in
``<resource>/data/projects/<id>/assistant/attachments``.  Nothing in this
module returns a local path to a model or the browser.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import mimetypes
import re
from pathlib import Path
from typing import Any
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from .project_storage import project_root
from .upload_storage import StagedUpload, UploadTooLarge, cleanup_staged_upload, finalize_staged_upload, stage_upload


MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
MAX_MESSAGE_ATTACHMENTS = 8
MAX_MESSAGE_BYTES = 200 * 1024 * 1024
MAX_IMAGE_VISION_BYTES = 20 * 1024 * 1024
MAX_EXTRACTED_CHARS = 40_000
MAX_TOTAL_EXTRACTED_CHARS = 80_000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DOCUMENT_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md", ".markdown"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}
REFERENCE_EXTENSIONS = {".srt", ".vtt"}
SUPPORTED_EXTENSIONS = IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | AUDIO_EXTENSIONS | VIDEO_EXTENSIONS | REFERENCE_EXTENSIONS

MIME_OVERRIDES = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".srt": "text/plain",
    ".vtt": "text/vtt",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def normalized_extension(filename: str | None) -> str:
    return Path(str(filename or "")).suffix.lower()


def attachment_kind(filename: str | None, mime_type: str | None = None) -> str:
    extension = normalized_extension(filename)
    if extension in IMAGE_EXTENSIONS or str(mime_type or "").lower().startswith("image/"):
        return "image"
    if extension in DOCUMENT_EXTENSIONS:
        return "document"
    if extension in AUDIO_EXTENSIONS or str(mime_type or "").lower().startswith("audio/"):
        return "audio"
    if extension in VIDEO_EXTENSIONS or str(mime_type or "").lower().startswith("video/"):
        return "video"
    if extension in REFERENCE_EXTENSIONS:
        return "reference"
    return "unsupported"


def mime_for_filename(filename: str | None, claimed: str | None = None) -> str:
    extension = normalized_extension(filename)
    if extension in MIME_OVERRIDES:
        return MIME_OVERRIDES[extension]
    guessed = mimetypes.guess_type(str(filename or ""))[0]
    return str(claimed or guessed or "application/octet-stream").split(";", 1)[0].strip().lower()


def validate_attachment_mime(filename: str | None, claimed: str | None = None) -> str:
    """Return a safe MIME for an allowed extension and reject clear mismatches."""

    extension = normalized_extension(filename)
    declared = str(claimed or "").split(";", 1)[0].strip().lower()
    generic = {"", "application/octet-stream", "binary/octet-stream"}
    expected = mime_for_filename(filename)
    if declared in generic:
        return expected
    if extension in IMAGE_EXTENSIONS and not declared.startswith("image/"):
        raise ValueError(f"{extension} 附件的 MIME 必须是 image/*，不能是 {declared}。")
    if extension in AUDIO_EXTENSIONS and not declared.startswith("audio/"):
        raise ValueError(f"{extension} 附件的 MIME 必须是 audio/*，不能是 {declared}。")
    if extension in VIDEO_EXTENSIONS and not declared.startswith("video/"):
        raise ValueError(f"{extension} 附件的 MIME 必须是 video/*，不能是 {declared}。")
    if extension in REFERENCE_EXTENSIONS and not (declared.startswith("text/") or declared in {"application/x-subrip", "text/vtt"}):
        raise ValueError(f"{extension} 附件的 MIME 必须是文本类型，不能是 {declared}。")
    if extension == ".pdf" and declared != "application/pdf":
        raise ValueError(f"PDF 附件的 MIME 必须是 application/pdf，不能是 {declared}。")
    if extension == ".docx" and declared not in {MIME_OVERRIDES[extension], "application/zip"}:
        raise ValueError(f"DOCX 附件的 MIME 不受支持：{declared}。")
    if extension == ".xlsx" and declared not in {MIME_OVERRIDES[extension], "application/zip"}:
        raise ValueError(f"XLSX 附件的 MIME 不受支持：{declared}。")
    if extension in {".txt", ".md", ".markdown", ".csv"} and not (declared.startswith("text/") or declared in {"application/csv", "application/vnd.ms-excel"}):
        raise ValueError(f"{extension} 文档的 MIME 必须是文本/CSV 类型，不能是 {declared}。")
    return expected if extension in MIME_OVERRIDES or expected.startswith(("image/", "audio/", "video/", "text/", "application/")) else declared


def safe_attachment_name(filename: str | None, fallback: str = "attachment.bin") -> str:
    basename = Path(str(filename or fallback)).name.replace("\x00", "")
    cleaned = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff ]+", "_", basename).strip(" ._")
    return cleaned[:180] or fallback


def assistant_project_root(data_dir: Path, project_id: str) -> Path:
    return project_root(data_dir, project_id) / "assistant"


def attachment_destination(data_dir: Path, project_id: str, attachment_id: str, filename: str) -> Path:
    extension = normalized_extension(filename)
    safe_extension = extension if re.fullmatch(r"\.[a-z0-9]{1,12}", extension) else ".bin"
    return assistant_project_root(data_dir, project_id) / "attachments" / f"{attachment_id}{safe_extension}"


def stage_attachment(upload: Any, destination: Path, maximum: int = MAX_ATTACHMENT_BYTES) -> StagedUpload:
    return stage_upload(upload, destination, maximum)


def _truncate(text: str, maximum: int = MAX_EXTRACTED_CHARS) -> tuple[str, bool]:
    normalized = str(text or "").replace("\x00", "").strip()
    if len(normalized) <= maximum:
        return normalized, False
    return normalized[:maximum].rstrip() + "\n\n[文档内容已按工作台抽取上限截断。]", True


def _decode_bytes(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _archive_member_bytes(archive: ZipFile, member: str) -> bytes:
    info = archive.getinfo(member)
    if info.file_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
        raise ValueError("文档压缩包展开后超过安全上限。")
    return archive.read(member)


def _archive_total_size(archive: ZipFile) -> None:
    total = 0
    for info in archive.infolist():
        if info.file_size < 0:
            raise ValueError("文档压缩包包含无效条目。")
        total += info.file_size
        if total > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError("文档压缩包展开后超过安全上限。")


def _docx_text(path: Path) -> str:
    with ZipFile(path) as archive:
        _archive_total_size(archive)
        raw = _archive_member_bytes(archive, "word/document.xml")
    root = ElementTree.fromstring(raw)
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    blocks: list[str] = []
    for child in root.iter():
        if child.tag == f"{namespace}p":
            value = "".join(node.text or "" for node in child.iter(f"{namespace}t"))
            if value.strip():
                blocks.append(value.strip())
        elif child.tag == f"{namespace}tr":
            cells: list[str] = []
            for cell in child.findall(f".//{namespace}tc"):
                value = "".join(node.text or "" for node in cell.iter(f"{namespace}t"))
                if value.strip():
                    cells.append(" ".join(value.split()))
            if cells:
                blocks.append("\t".join(cells))
    return "\n".join(blocks)


def _xlsx_text(path: Path) -> str:
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel_namespace = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    with ZipFile(path) as archive:
        _archive_total_size(archive)
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ElementTree.fromstring(_archive_member_bytes(archive, "xl/sharedStrings.xml"))
            for item in shared_root.findall(f"{namespace}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{namespace}t")))
        workbook = ElementTree.fromstring(_archive_member_bytes(archive, "xl/workbook.xml"))
        relationships: dict[str, str] = {}
        if "xl/_rels/workbook.xml.rels" in archive.namelist():
            rel_root = ElementTree.fromstring(_archive_member_bytes(archive, "xl/_rels/workbook.xml.rels"))
            for relation in rel_root:
                rel_id = relation.attrib.get("Id")
                target = relation.attrib.get("Target")
                if rel_id and target:
                    relationships[rel_id] = target.lstrip("/") if target.startswith("/") else f"xl/{target}" if not target.startswith("xl/") else target
        blocks: list[str] = []
        sheets = workbook.find(f"{namespace}sheets")
        if sheets is None:
            return ""
        for sheet in sheets.findall(f"{namespace}sheet"):
            name = sheet.attrib.get("name") or "Sheet"
            rel_id = sheet.attrib.get(f"{rel_namespace}id")
            target = relationships.get(rel_id or "")
            if not target or target not in archive.namelist():
                continue
            sheet_root = ElementTree.fromstring(_archive_member_bytes(archive, target))
            rows: list[str] = []
            for row in sheet_root.findall(f".//{namespace}row"):
                values: list[str] = []
                for cell in row.findall(f"{namespace}c"):
                    value_node = cell.find(f"{namespace}v")
                    value = value_node.text if value_node is not None else ""
                    if cell.attrib.get("t") == "s" and value.isdigit():
                        value = shared[int(value)] if int(value) < len(shared) else value
                    elif cell.attrib.get("t") == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(f"{namespace}t"))
                    values.append(value or "")
                if values:
                    rows.append("\t".join(values))
            if rows:
                blocks.append(f"[{name}]\n" + "\n".join(rows))
    return "\n\n".join(blocks)


def _csv_text(path: Path) -> str:
    raw = _decode_bytes(path.read_bytes())
    rows = csv.reader(io.StringIO(raw))
    return "\n".join("\t".join(cell.strip() for cell in row) for row in rows)


def _pdf_text(path: Path) -> str:
    # These imports are optional at source checkout time but are declared in
    # requirements.txt. Keeping the fallback explicit gives the UI a useful
    # extraction error instead of silently pretending a PDF was understood.
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        return "\n\n".join((page.extract_text() or "") for page in reader.pages)
    except ImportError as exc:
        raise RuntimeError("PDF 抽取依赖未安装，请安装 requirements.txt 中的 pypdf。") from exc


def extract_document(path: Path, filename: str | None = None, mime_type: str | None = None, maximum: int = MAX_EXTRACTED_CHARS) -> dict[str, Any]:
    """Extract bounded text locally without contacting a Provider."""

    name = filename or path.name
    extension = normalized_extension(name)
    kind = attachment_kind(name, mime_type)
    if kind != "document":
        return {"status": "not_applicable", "text": "", "char_count": 0, "truncated": False, "kind": kind}
    try:
        if extension in {".txt", ".md", ".markdown"}:
            text = _decode_bytes(path.read_bytes())
        elif extension == ".csv":
            text = _csv_text(path)
        elif extension == ".docx":
            text = _docx_text(path)
        elif extension == ".xlsx":
            text = _xlsx_text(path)
        elif extension == ".pdf":
            text = _pdf_text(path)
        else:
            return {"status": "unsupported", "text": "", "char_count": 0, "truncated": False, "kind": kind}
        bounded, truncated = _truncate(text, maximum)
        return {
            "status": "succeeded",
            "text": bounded,
            "char_count": len(bounded),
            "truncated": truncated,
            "kind": kind,
            "extension": extension,
        }
    except (OSError, UnicodeError, ElementTree.ParseError, BadZipFile, KeyError, ValueError, RuntimeError) as exc:
        return {
            "status": "failed",
            "text": "",
            "char_count": 0,
            "truncated": False,
            "kind": kind,
            "extension": extension,
            "error": str(exc)[:1000],
        }


def image_data_url(path: Path, mime_type: str | None = None, maximum: int = MAX_IMAGE_VISION_BYTES) -> str:
    """Return an image data URL only after the caller has checked the limit."""

    if path.stat().st_size > maximum:
        raise ValueError("发送给 vision Provider 的图片超过 20MB 限制。")
    mime = mime_for_filename(path.name, mime_type)
    if not mime.startswith("image/"):
        raise ValueError("附件不是受支持的图片类型。")
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def delivery_mode_for_attachment(kind: str, *, vision_supported: bool, size: int) -> tuple[str, str | None]:
    if kind == "image":
        if not vision_supported:
            return "project_reference", "当前 Provider 不支持 vision 图片理解。"
        if size > MAX_IMAGE_VISION_BYTES:
            return "project_reference", "图片超过 vision Provider 的 20MB 单图上限。"
        return "multimodal", None
    if kind == "document":
        return "extracted_text", None
    if kind in {"audio", "video", "reference"}:
        return "project_reference", "第一版仅保存为项目资料引用，不进行内容分析。"
    return "unsupported", "文件类型不在创作助手支持范围内。"


def attachment_file_is_safe(path: Path, data_dir: Path, project_id: str) -> bool:
    root = assistant_project_root(data_dir, project_id).resolve()
    try:
        path.resolve().relative_to(root)
    except ValueError:
        return False
    return path.is_file()


__all__ = [
    "MAX_ATTACHMENT_BYTES",
    "MAX_MESSAGE_ATTACHMENTS",
    "MAX_MESSAGE_BYTES",
    "MAX_IMAGE_VISION_BYTES",
    "MAX_EXTRACTED_CHARS",
    "MAX_TOTAL_EXTRACTED_CHARS",
    "SUPPORTED_EXTENSIONS",
    "attachment_kind",
    "mime_for_filename",
    "validate_attachment_mime",
    "safe_attachment_name",
    "assistant_project_root",
    "attachment_destination",
    "stage_attachment",
    "extract_document",
    "image_data_url",
    "delivery_mode_for_attachment",
    "attachment_file_is_safe",
    "UploadTooLarge",
    "cleanup_staged_upload",
    "finalize_staged_upload",
]
