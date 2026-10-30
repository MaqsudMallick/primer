from datetime import UTC, datetime
import json
import logging
from typing import Any


logger = logging.getLogger("voice_agent.metrics")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


def log_metric(event: str, **fields: Any) -> None:
    record = {
        "timestamp": datetime.now(UTC).isoformat(),
        "event": event,
        **fields,
    }
    logger.info(json.dumps(record, separators=(",", ":"), sort_keys=True))
