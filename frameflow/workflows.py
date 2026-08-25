from __future__ import annotations

from typing import Any


WORKFLOWS: dict[str, dict[str, Any]] = {
    "video-script-storyboard": {"version": "1.0.0", "next_routes": ["video-asset-regulator"], "approval_policy": "text_auto"},
    "video-asset-regulator": {"version": "1.0.0", "next_routes": ["video-character-design-director", "video-scene-design-director", "video-prop-design-director"], "approval_policy": "deterministic_gate"},
    "video-character-design-director": {"version": "1.0.0", "next_routes": ["video-asset-regulator"], "approval_policy": "media_qa"},
    "video-scene-design-director": {"version": "1.0.0", "next_routes": ["video-asset-regulator"], "approval_policy": "media_qa"},
    "video-prop-design-director": {"version": "1.0.0", "next_routes": ["video-asset-regulator"], "approval_policy": "media_qa"},
    "video-fusion-production-director": {"version": "1.0.0", "next_routes": ["video-asset-regulator"], "approval_policy": "media_qa"},
    "video-shot-director": {"version": "1.0.0", "next_routes": ["seedance-shot-packager"], "approval_policy": "deterministic_gate"},
    "seedance-shot-packager": {"version": "2.5.0", "next_routes": ["video-shot-director"], "approval_policy": "paid_confirmation"},
    "voice-controller": {"version": "2.0.0", "next_routes": ["voice-performance-director", "music-sound-designer", "video-asset-regulator"], "approval_policy": "paid_confirmation"},
    "voice-performance-director": {"version": "1.0.0", "next_routes": ["voice-controller", "video-shot-director"], "approval_policy": "paid_confirmation"},
    "music-sound-designer": {"version": "1.0.0", "next_routes": ["voice-controller", "video-shot-director"], "approval_policy": "paid_confirmation"},
    "final-render": {"version": "1.0.0", "next_routes": [], "approval_policy": "final_confirmation"},
}


def _shot_directed(shot: dict[str, Any]) -> bool:
    package = shot.get("directorPackage") or shot.get("directorPackageId") or shot.get("directorApprovedPackage")
    approved = shot.get("directorApproved") in (True, "Approved", "approved")
    return bool(package) and approved


def evaluate_project_gates(project: dict[str, Any], skill_id: str) -> dict[str, Any]:
    assets = project.get("assets") or []
    shots = project.get("shots") or []
    required = [a for a in assets if str(a.get("grade", "")).startswith("A")]
    missing = [a.get("id") for a in required if not (
        a.get("status") in {"ready", "approved"} and
        (a.get("artifactId") or a.get("filePath")) and
        a.get("qaDecision") == "Approved" and
        a.get("regulatorRegistered") is True
    )]
    result = {"allowed": True, "missing": [], "checks": {}}
    if skill_id in {"video-shot-director", "seedance-shot-packager", "final-render"}:
        result["checks"]["required_assets_ready"] = not missing
        result["missing"].extend(missing)
    if skill_id in {"seedance-shot-packager", "final-render"}:
        # video-shot-director is a mandatory, non-bypassable gate before Seedance packaging.
        undirected = [s.get("id") for s in shots if not _shot_directed(s)]
        result["checks"]["shots_directed"] = not undirected
        result["missing"].extend(undirected)
    result["allowed"] = not result["missing"]
    return result


def workflow_manifest(skill_id: str) -> dict[str, Any]:
    workflow = WORKFLOWS.get(skill_id)
    if workflow is None:
        raise KeyError(skill_id)
    return {
        "skill_id": skill_id,
        "skill_version": workflow["version"],
        "input_schema": {"type": "object", "additionalProperties": False},
        "output_schema": {"type": "object", "additionalProperties": False},
        "instructions": "使用稳定 ID，所有更改创建新版本，不覆盖已批准产物。",
        "deterministic_gates": ["required_assets_ready", "shots_ready"],
        "next_routes": workflow["next_routes"],
        "approval_policy": workflow["approval_policy"],
    }
