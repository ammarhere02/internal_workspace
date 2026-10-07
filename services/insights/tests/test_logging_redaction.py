"""Secrets never reach the log (PDF §13 secret leakage): the structlog processor scrubs user:password@ in any value."""
from app.logging import _redact


def test_atlas_uri_password_is_redacted_in_any_field():
    out = _redact(None, None, {"event": "boot", "uri": "mongodb+srv://mgmt_user:Sup3r$ecret@cluster0.abc.mongodb.net/?retryWrites=true", "error": "auth failed for mongodb://u:p@host:27017"})
    assert out["uri"] == "mongodb+srv://mgmt_user:[redacted]@cluster0.abc.mongodb.net/?retryWrites=true"
    assert out["error"] == "auth failed for mongodb://u:[redacted]@host:27017"
    assert "Sup3r" not in str(out)


def test_nats_credentials_in_url_are_redacted_too():
    out = _redact(None, None, {"nats": "nats://svc:token123@nats:4222"})
    assert out["nats"] == "nats://svc:[redacted]@nats:4222"
