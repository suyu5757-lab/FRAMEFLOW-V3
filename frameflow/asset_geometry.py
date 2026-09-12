from __future__ import annotations

from typing import Any


SUPPORTED_ASPECT_RATIOS = ("16:9", "1:1", "9:16")

ASPECT_RATIO_TO_IMAGE_SIZE = {
    "16:9": "1536x1024",
    "1:1": "1024x1024",
    "9:16": "1024x1536",
}

IMAGE_SIZE_TO_PROVIDER_ASPECT_RATIO = {
    "1536x1024": "3:2",
    "1024x1024": "1:1",
    "1024x1536": "2:3",
}

DEFAULT_BASE_ASSET_ASPECT_RATIOS = {
    "character": "16:9",
    "scene": "16:9",
    "prop": "1:1",
    "product": "1:1",
    "style": "16:9",
}

BASE_ASSET_LAYOUT_PROFILES = {
    "character": "character_reference_sheet",
    "scene": "empty_environment_board",
    "prop": "isolated_object_board",
    "product": "isolated_product_board",
    "style": "style_reference_board",
    "fusion": "fusion_frame",
}


def normalize_aspect_ratio(value: Any, fallback: str = "1:1") -> str:
    """Normalize only the image sizes currently supported by the studio."""

    candidate = str(value or "").strip().lower().replace("×", "x")
    aliases = {
        "1536x1024": "16:9",
        "1024x1024": "1:1",
        "1024x1536": "9:16",
    }
    normalized = aliases.get(candidate, candidate)
    if normalized in SUPPORTED_ASPECT_RATIOS:
        return normalized
    safe_fallback = aliases.get(str(fallback or "").strip().lower(), str(fallback or "").strip())
    return safe_fallback if safe_fallback in SUPPORTED_ASPECT_RATIOS else "1:1"


def image_size_for_aspect_ratio(aspect_ratio: Any) -> str:
    return ASPECT_RATIO_TO_IMAGE_SIZE.get(normalize_aspect_ratio(aspect_ratio), "1024x1024")


def provider_aspect_ratio_for_image_size(image_size: Any) -> str | None:
    """Return the provider's physical canvas ratio for an API size.

    The semantic asset ratio and the currently supported provider sizes are
    intentionally separate. For example, a character asset may require a
    16:9 design canvas while the current image endpoint accepts 1536x1024
    (3:2) as its landscape size. Keeping this fact explicit prevents the
    metadata from claiming a pixel-exact ratio that the provider did not
    return.
    """

    return IMAGE_SIZE_TO_PROVIDER_ASPECT_RATIO.get(str(image_size or "").strip())


def asset_layout_profile(asset_class: Any) -> str | None:
    """Return the stable base-image layout profile for one asset class."""

    value = str(asset_class or "").strip().lower()
    aliases = {
        "environment": "scene",
        "environment_prop": "scene",
        "environment_state": "scene",
        "background": "scene",
        "item": "prop",
        "product": "product",
    }
    canonical = aliases.get(value, value)
    return BASE_ASSET_LAYOUT_PROFILES.get(canonical)


def asset_generation_profile(
    asset_class: Any,
    project_output_aspect_ratio: Any = "9:16",
    explicit_aspect_ratio: Any = None,
) -> dict[str, str | None]:
    """Return the reference-image geometry for one logical asset.

    The project ratio describes the final shot/video canvas. Only Fusion and
    shot-level outputs inherit it. Base assets use a class-specific canvas so
    their identity, material, and spatial evidence are not cropped into the
    final delivery format prematurely.
    """

    asset_class_name = str(asset_class or "").strip().lower()
    if asset_class_name in {"audio", "music", "sfx"}:
        return {"aspect_ratio": None, "image_size": None, "source": "not_applicable"}
    if explicit_aspect_ratio not in (None, ""):
        aspect_ratio = normalize_aspect_ratio(explicit_aspect_ratio)
        return {"aspect_ratio": aspect_ratio, "image_size": image_size_for_aspect_ratio(aspect_ratio), "source": "manual"}
    if asset_class_name == "fusion":
        aspect_ratio = normalize_aspect_ratio(project_output_aspect_ratio, "9:16")
        return {"aspect_ratio": aspect_ratio, "image_size": image_size_for_aspect_ratio(aspect_ratio), "source": "project_output"}
    aspect_ratio = DEFAULT_BASE_ASSET_ASPECT_RATIOS.get(asset_class_name, "1:1")
    return {"aspect_ratio": aspect_ratio, "image_size": image_size_for_aspect_ratio(aspect_ratio), "source": "class_default"}
