from __future__ import annotations

import os

SERVICE_NAME = "FRAMEFLOW"


class SecretStoreError(RuntimeError):
    pass


def _keyring():
    try:
        import keyring
        return keyring
    except ImportError as exc:
        raise SecretStoreError("系统凭据组件未安装，请安装 requirements.txt。") from exc


def set_secret(reference: str, value: str) -> None:
    _keyring().set_password(SERVICE_NAME, reference, value)


def get_secret(reference: str | None, environment_variable: str | None = None) -> str | None:
    if reference:
        try:
            value = _keyring().get_password(SERVICE_NAME, reference)
            if value:
                return value
        except Exception:
            pass
    return os.environ.get(environment_variable or "") or None


def delete_secret(reference: str) -> None:
    try:
        _keyring().delete_password(SERVICE_NAME, reference)
    except Exception as exc:
        raise SecretStoreError("系统凭据不存在或无法删除。") from exc


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:3]}••••{value[-4:]}"
