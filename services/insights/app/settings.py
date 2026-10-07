from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

STREAM_NAME = "TEAM_EVENTS"
STREAM_SUBJECTS = ["tm.v1.>"]
CONSUMER_NAME = "activity-insights-v1"
INSIGHTS_QUERY_SUBJECT = "tm.query.v1.project_insights"
ACTIVITY_QUERY_SUBJECT = "tm.query.v1.project_activity"


class Settings(BaseSettings):
    """All configuration comes from the environment; .env is only a local convenience."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongodb_uri: str = Field(min_length=10)
    insights_db_name: str = "insights_db"
    nats_url: str = "nats://localhost:4222"
    health_port: int = 8001
    log_level: str = "INFO"
    mongo_timeout_ms: int = 5000
    contracts_dir: str = ""
    # projection set / consumer identity: change BOTH together to switch to a rebuilt projection (docs/replay.md)
    consumer_name: str = CONSUMER_NAME
    projection_set: str = ""
    query_timeout_s: float = 2.0
    # consumer policy
    consumer_max_deliver: int = 5
    consumer_ack_wait_s: int = 30
    consumer_batch: int = 10

    def contracts_path(self) -> Path:
        if self.contracts_dir:
            return Path(self.contracts_dir)
        return (Path.cwd() / ".." / ".." / "contracts").resolve()
