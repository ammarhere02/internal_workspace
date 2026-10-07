from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class ConsumerState:
    """Operator-visible consumer state, served by /health/consumer (PDF §10, §13)."""

    status: str = "starting"  # starting | running | stopped | error
    last_stream_seq: int | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    processed: int = 0
    failed: int = 0
    duplicates: int = 0
    unrecorded_failures: int = 0  # failure records that could not be persisted: investigate the log
    open_failures: int | None = None  # processing_failures rows awaiting an operator (refreshed by /health/consumer)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def mark_success(self, seq: int) -> None:
        self.last_stream_seq = seq
        self.last_success_at = datetime.now(UTC)
        self.processed += 1

    def processing_age_ms(self) -> int | None:
        if self.last_success_at is None:
            return None
        return int((datetime.now(UTC) - self.last_success_at).total_seconds() * 1000)

    def snapshot(self) -> dict:
        return {
            "status": self.status,
            "lastStreamSeq": self.last_stream_seq,
            "lastSuccessAt": self.last_success_at.isoformat() if self.last_success_at else None,
            "processingAgeMs": self.processing_age_ms(),
            "processed": self.processed,
            "failed": self.failed,
            "duplicates": self.duplicates,
            "unrecordedFailures": self.unrecorded_failures,
            "openFailures": self.open_failures,
            "lastError": self.last_error,
        }
