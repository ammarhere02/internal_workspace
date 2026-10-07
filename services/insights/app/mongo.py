from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from app.settings import Settings


def make_client(settings: Settings) -> AsyncMongoClient:
    t = settings.mongo_timeout_ms
    return AsyncMongoClient(
        settings.mongodb_uri,
        serverSelectionTimeoutMS=t,
        connectTimeoutMS=t,
        socketTimeoutMS=t * 4,
        maxPoolSize=10,
        appname="insights-service",
    )


def owned_db(client: AsyncMongoClient, settings: Settings) -> AsyncDatabase:
    """The ONLY database this service touches: insights_db."""
    return client[settings.insights_db_name]


async def ping(db: AsyncDatabase) -> bool:
    try:
        await db.command("ping")
        return True
    except Exception:
        return False
