from __future__ import annotations

import hashlib
import ipaddress
import json
import mimetypes
import os
import shutil
import socket
import struct
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import httpx


TRUSTED_DOWNLOAD_SUFFIXES = (".volces.com", ".volcengine.com", ".byteplus.com", ".tos-cn-beijing.volces.com")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def find_binary(name: str, configured: str | None = None) -> str | None:
    environment_name = "FRAMEFLOW_FFMPEG_PATH" if name == "ffmpeg" else "FRAMEFLOW_FFPROBE_PATH"
    configured_path = configured or os.environ.get(environment_name, "").strip()
    if configured_path:
        candidate = Path(configured_path).expanduser().resolve()
        if candidate.is_file():
            return str(candidate)
    return shutil.which(name)


def media_info(path: Path, ffprobe: str | None = None) -> dict:
    binary = find_binary("ffprobe", ffprobe)
    if not binary:
        return {}
    result = subprocess.run([binary, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
    if result.returncode:
        return {"error": result.stderr[-1000:]}
    return json.loads(result.stdout)


def safe_project_path(data_root: Path, project_id: str, relative: str) -> Path:
    if not project_id or Path(project_id).name != project_id or project_id in {".", ".."} or any(char in project_id for char in "\\/\x00"):
        raise ValueError("项目 ID 不是安全的单级目录名。")
    project_root = (data_root / "projects" / project_id).resolve()
    candidate = (project_root / relative).resolve()
    if candidate != project_root and project_root not in candidate.parents:
        raise ValueError("文件路径超出当前项目目录。")
    return candidate


def validate_remote_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("只允许下载 HTTPS 供应商结果。")
    hostname = parsed.hostname.lower()
    if not any(hostname.endswith(suffix) for suffix in TRUSTED_DOWNLOAD_SUFFIXES):
        raise ValueError("结果 URL 不在可信供应商域名中。")
    for info in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(info[4][0])
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved:
            raise ValueError("结果 URL 解析到了非公网地址。")


async def download_provider_artifact(url: str, destination: Path, maximum: int = 1024 * 1024 * 1024) -> None:
    validate_remote_url(url)
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20), follow_redirects=False) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            with destination.open("wb") as handle:
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > maximum:
                        raise ValueError("供应商结果超过允许大小。")
                    handle.write(chunk)


def render_video(ffmpeg: str, clips: list[Path], output: Path, resolution: str, fps: int, audio_tracks: list[tuple[Path, dict]] | None = None) -> None:
    width, height = resolution.lower().split("x", 1)
    normalized = output.parent / "normalized"
    normalized.mkdir(parents=True, exist_ok=True)
    normalized_clips: list[Path] = []
    for index, source in enumerate(clips):
        target = normalized / f"clip-{index:04d}.mp4"
        command = [
            ffmpeg, "-y", "-i", str(source), "-vf",
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", str(target),
        ]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=1800, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        normalized_clips.append(target)
    manifest = output.parent / "concat.txt"
    manifest.write_text("\n".join(f"file '{path.resolve().as_posix().replace("'", "'\\''")}'" for path in normalized_clips), encoding="utf-8")
    picture = output if not audio_tracks else output.with_name(output.stem + "-picture.mp4")
    result = subprocess.run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(picture)], capture_output=True, text=True, encoding="utf-8", timeout=1800, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    if audio_tracks:
        command = [ffmpeg, "-y", "-i", str(picture)]
        filters, labels = [], []
        for index, (track, settings) in enumerate(audio_tracks, start=1):
            command.extend(["-i", str(track)])
            delay = round(float(settings.get("start", 0)) * 1000)
            chain = f"[{index}:a]adelay={delay}:all=1,volume={float(settings.get('volume', 1))}"
            if float(settings.get("fade_in", 0)) > 0:
                chain += f",afade=t=in:st={float(settings.get('start', 0))}:d={float(settings['fade_in'])}"
            chain += f"[a{index}]"; filters.append(chain); labels.append(f"[a{index}]")
        filters.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0[mix]")
        command.extend(["-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", str(output)])
        mixed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=1800, check=False)
        if mixed.returncode:
            raise RuntimeError(mixed.stderr[-2000:])


def render_timeline(
    ffmpeg: str,
    timeline: dict,
    artifact_paths: dict[str, Path],
    output: Path,
    subtitle_path: Path | None = None,
) -> None:
    """Render the editable V3 timeline with a deterministic FFmpeg graph.

    The renderer deliberately accepts resolved artifact paths rather than user
    supplied filesystem paths. Timeline clips are positioned on a black base,
    which makes gaps deterministic and keeps overlay/audio track semantics
    stable across exports.
    """
    width = int(timeline["width"])
    height = int(timeline["height"])
    fps = int(timeline["fps"])
    duration = float(timeline["duration"])
    tracks = timeline.get("tracks") or []
    video_items: list[tuple[Path, dict]] = []
    audio_items: list[tuple[Path, dict]] = []
    for track in tracks:
        if track.get("muted"):
            continue
        kind = track.get("kind")
        for clip in track.get("clips") or []:
            artifact_id = clip.get("artifact_id")
            source = artifact_paths.get(str(artifact_id)) if artifact_id else None
            if not source or not source.is_file():
                raise ValueError(f"时间线片段 {clip.get('id')} 的 artifact 不存在。")
            if kind in {"video", "overlay"}:
                video_items.append((source, clip))
            elif kind in {"dialogue", "music", "ambience", "sfx"}:
                audio_items.append((source, clip))
    if not video_items:
        raise ValueError("时间线至少需要一个视频或叠加视频片段。")

    inputs: list[str] = ["-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r={fps}:d={duration:.6f}"]
    for path, _ in video_items + audio_items:
        inputs.extend(["-i", str(path)])
    filters: list[str] = [f"[0:v]format=yuv420p[base0]"]
    base_label = "base0"
    for offset, (_, clip) in enumerate(video_items, start=1):
        source_in = float(clip.get("source_in") or 0)
        clip_duration = float(clip["duration"])
        speed = float(clip.get("speed") or 1)
        start = float(clip.get("start") or 0)
        input_duration = clip_duration * speed
        video_label = f"v{offset}"
        filters.append(
            f"[{offset}:v]trim=start={source_in:.6f}:duration={input_duration:.6f},"
            f"setpts=PTS-STARTPTS,setpts=PTS/{speed:.6f},"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
            f"setpts=PTS+{start:.6f}/TB[{video_label}]"
        )
        next_base = f"base{offset}"
        filters.append(f"[{base_label}][{video_label}]overlay=eof_action=pass:shortest=0:format=auto[{next_base}]")
        base_label = next_base
    audio_labels: list[str] = []
    audio_start_index = 1 + len(video_items)
    for index, (_, clip) in enumerate(audio_items, start=audio_start_index):
        source_in = float(clip.get("source_in") or 0)
        clip_duration = float(clip["duration"])
        start = float(clip.get("start") or 0)
        volume = float(clip.get("volume") or 1)
        label = f"a{index}"
        delay = max(0, round(start * 1000))
        chain = f"[{index}:a]atrim=start={source_in:.6f}:duration={clip_duration:.6f},asetpts=PTS-STARTPTS"
        chain += f",adelay={delay}:all=1,volume={volume:.6f}"
        fade_in = float(clip.get("fade_in") or 0)
        fade_out = float(clip.get("fade_out") or 0)
        if fade_in > 0:
            chain += f",afade=t=in:st=0:d={fade_in:.6f}"
        if fade_out > 0:
            fade_start = max(0, clip_duration - fade_out)
            chain += f",afade=t=out:st={fade_start:.6f}:d={fade_out:.6f}"
        chain += f"[{label}]"
        filters.append(chain)
        audio_labels.append(f"[{label}]")
    if audio_labels:
        filters.append("".join(audio_labels) + f"amix=inputs={len(audio_labels)}:duration=longest:normalize=0[aout]")

    output.parent.mkdir(parents=True, exist_ok=True)
    video_label = base_label
    if subtitle_path and subtitle_path.is_file():
        subtitle_file = subtitle_path.resolve().as_posix().replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
        filters.append(f"[{base_label}]subtitles=filename='{subtitle_file}':force_style='FontName=Microsoft YaHei,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,MarginV=72,Alignment=2'[captioned]")
        video_label = "captioned"
    command = [ffmpeg, "-y", *inputs, "-filter_complex", ";".join(filters), "-map", f"[{video_label}]", "-t", f"{duration:.6f}"]
    if audio_labels:
        command.extend(["-map", "[aout]"])
    else:
        command.append("-an")
    command.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", str(output)])
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=3600, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])


def create_proxy(ffmpeg: str, source: Path, output: Path, preset: str) -> dict[str, object]:
    """Create a rebuildable local preview proxy without modifying the source."""
    heights = {"preview_360p": 360, "preview_540p": 540, "preview_720p": 720}
    height = heights.get(preset)
    if not height:
        raise ValueError("未知代理预设。")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [ffmpeg, "-y", "-i", str(source), "-vf", f"scale=-2:{height}", "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(output)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-2000:])
    thumbnail = output.with_suffix(".jpg")
    thumb_result = subprocess.run(
        [ffmpeg, "-y", "-ss", "0", "-i", str(source), "-frames:v", "1", "-vf", f"scale=-2:{height}", str(thumbnail)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    waveform = output.with_suffix(".png")
    waveform_result = subprocess.run(
        [ffmpeg, "-y", "-i", str(source), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=0xd7ff4b", "-frames:v", "1", str(waveform)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    result_payload: dict[str, object] = {"path": str(output), "preset": preset, "bytes": output.stat().st_size, "sha256": sha256_file(output)}
    if thumb_result.returncode == 0 and thumbnail.is_file():
        result_payload["thumbnail"] = str(thumbnail)
        result_payload["thumbnail_sha256"] = sha256_file(thumbnail)
    if waveform_result.returncode == 0 and waveform.is_file():
        result_payload["waveform"] = str(waveform)
        result_payload["waveform_sha256"] = sha256_file(waveform)
    return result_payload


# ---------------------------------------------------------------------------
# Pure-Python media sniffing used by the asset intake technical validator.
# ---------------------------------------------------------------------------

IMAGE_SIGNATURES = {
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".webp": b"RIFF",
    ".gif": b"GIF8",
}


def sniff_image_format(raw: bytes) -> str | None:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if len(raw) >= 6 and raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def _jpeg_dimensions(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 4 or raw[0] != 0xFF or raw[1] != 0xD8:
        return None
    index = 2
    length = len(raw)
    while index + 9 < length:
        if raw[index] != 0xFF:
            index += 1
            continue
        marker = raw[index + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if index + 4 > length:
            return None
        segment_length = struct.unpack(">H", raw[index + 2:index + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if index + 9 > length:
                return None
            height = struct.unpack(">H", raw[index + 5:index + 7])[0]
            width = struct.unpack(">H", raw[index + 7:index + 9])[0]
            return width, height
        index += 2 + segment_length
    return None


def image_dimensions(raw: bytes) -> tuple[int, int] | None:
    kind = sniff_image_format(raw)
    if kind == "png" and len(raw) >= 24:
        return struct.unpack(">II", raw[16:24])
    if kind == "jpeg":
        return _jpeg_dimensions(raw)
    if kind == "gif" and len(raw) >= 10:
        return struct.unpack("<HH", raw[6:10])
    if kind == "webp" and len(raw) >= 30:
        chunk = raw[12:16]
        if chunk == b"VP8X" and len(raw) >= 30:
            width = 1 + (raw[24] | (raw[25] << 8) | (raw[26] << 16))
            height = 1 + (raw[27] | (raw[28] << 8) | (raw[29] << 16))
            return width, height
        if chunk == b"VP8 " and len(raw) >= 30:
            width = struct.unpack("<H", raw[26:28])[0] & 0x3FFF
            height = struct.unpack("<H", raw[28:30])[0] & 0x3FFF
            return width, height
        if chunk == b"VP8L" and len(raw) >= 25 and raw[20] == 0x2F:
            bits = raw[21] | (raw[22] << 8) | (raw[23] << 16) | (raw[24] << 24)
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height
    return None


def audio_signature_ok(ext: str, raw: bytes) -> bool:
    if ext == ".wav":
        return len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
    if ext == ".mp3":
        return raw.startswith(b"ID3") or raw.startswith(b"\xff\xfb") or raw.startswith(b"\xff\xf3") or raw.startswith(b"\xff\xf2")
    if ext in (".m4a", ".aac"):
        return len(raw) >= 12 and raw[4:8] == b"ftyp"
    if ext == ".flac":
        return raw.startswith(b"fLaC")
    if ext == ".ogg":
        return raw.startswith(b"OggS")
    return True


def video_signature_ok(ext: str, raw: bytes) -> bool:
    if ext == ".mp4":
        return len(raw) >= 12 and raw[4:8] == b"ftyp"
    if ext in (".webm", ".mkv"):
        return raw.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".mov":
        return len(raw) >= 12 and raw[4:8] == b"ftyp"
    return True
