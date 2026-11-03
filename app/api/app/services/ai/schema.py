"""Response schemas are written once in a neutral JSON Schema subset (lowercase ``type``,
``properties``, ``required``, ``items``, ``description``, ``nullable: true``) and converted per
provider (ARC-08c; v1 ``toOpenAIStrictSchema``). Pure."""

from typing import Any

_TYPES = {"object", "array", "string", "number", "integer", "boolean"}


def _type(node: Any) -> str | None:
    if not isinstance(node, dict):
        return None
    t = node.get("type")
    return t.lower() if isinstance(t, str) and t.lower() in _TYPES else None


def to_openai_strict_schema(node: Any) -> dict[str, Any]:
    """OpenAI Structured Outputs (``strict: true``): every object closed and fully required,
    nullable leaves as ``anyOf [T, null]``. Also used by OpenAI-compatible providers."""
    t = _type(node)
    if t is None:
        return {}
    out: dict[str, Any] = {}
    if t == "object" and isinstance(node.get("properties"), dict):
        props = node["properties"]
        out["type"] = "object"
        out["properties"] = {k: to_openai_strict_schema(v) for k, v in props.items()}
        out["required"] = list(props)
        out["additionalProperties"] = False
    elif t == "array":
        out["type"] = "array"
        if "items" in node:
            out["items"] = to_openai_strict_schema(node["items"])
    elif node.get("nullable") is True:
        out["anyOf"] = [{"type": t}, {"type": "null"}]
    else:
        out["type"] = t
    if isinstance(node.get("description"), str):
        out["description"] = node["description"]
    return out


def to_gemini_schema(node: Any) -> dict[str, Any]:
    """Gemini ``responseSchema`` (OpenAPI subset): upper-case types, ``nullable`` kept."""
    t = _type(node)
    if t is None:
        return {}
    out: dict[str, Any] = {"type": t.upper()}
    if isinstance(node.get("description"), str):
        out["description"] = node["description"]
    if node.get("nullable") is True:
        out["nullable"] = True
    if t == "object" and isinstance(node.get("properties"), dict):
        out["properties"] = {k: to_gemini_schema(v) for k, v in node["properties"].items()}
        req = node.get("required")
        out["required"] = list(req) if isinstance(req, list) else list(node["properties"])
    elif t == "array" and "items" in node:
        out["items"] = to_gemini_schema(node["items"])
    return out
