import logging
import re
import sys

import structlog

_SECRET = re.compile(r"//([^:/@\s]+):([^@\s]+)@")


def _redact(_logger, _method, event_dict):
    """Scrub user:password@ from any string value so an Atlas URI can never reach the log."""
    for k, v in list(event_dict.items()):
        if isinstance(v, str) and "@" in v:
            event_dict[k] = _SECRET.sub(r"//\1:[redacted]@", v)
    return event_dict


def configure_logging(level: str = "INFO", service: str = "insights-service") -> None:
    logging.basicConfig(level=level, stream=sys.stdout, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
        logger_factory=structlog.PrintLoggerFactory(sys.stdout),
    )
    structlog.contextvars.bind_contextvars(service=service)


def get_logger(name: str):
    return structlog.get_logger(name)
