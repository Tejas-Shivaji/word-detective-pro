"""HTTP contract, privacy, resource-limit and integration tests.

All CSV data below is constructed test data, not a research dataset.
"""
import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from word_detective.api import BodyLimitMiddleware, Budget, DatasetStore, Settings, create_app
from word_detective.core import (
    Limits, Provenance, ResearchError, Summary, TextReport, WordPage, WordReport, load_csv,
)

CSV = b"text,label,category\ncat cat dog,ai,animals\ndog,human,animals\n"
PARAMS = {"source_origin": "Constructed API test fixture; not research evidence"}
CSV_HEADERS = {"Content-Type": "text/csv"}


@pytest.fixture
 def_placeholder():
    pass
