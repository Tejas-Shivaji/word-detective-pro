"""FastAPI transport and bounded, ephemeral dataset sessions.

Run one worker for this in-memory research backend. Never expose it directly to
untrusted traffic without authentication, TLS and reverse-proxy resource limits.
CSV bodies are streamed through a hard byte cap before parsing; no multipart
parser, client filenames, filesystem storage or external model API is involved.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Annotated, Iterator
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import Field
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from word_detective.core import (
    Analysis, Corpus, Limits, Options, Provenance, ResearchError, Schema,
    Summary, TextReport, WordPage, WordReport, analyze_text, load_csv, select, summary,
)


@dataclass(frozen=True)
class Settings:
    limits: Limits = Limits()
    max_sessions: int = 4
    ttl_seconds: int = 900
    requests_per_minute: int = 120
    concurrent_analyses: int = 2
    cors_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if min(self.max_sessions, self.ttl_seconds, self.requests_per_minute, self.concurrent_analyses) < 1:
            raise ValueError("Session and request limits must be positive.")
        for origin in self.cors_origins:
            parsed = urlparse(origin)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
                raise ValueError("CORS origins must be explicit http(s) origins without paths or credentials.")

    @classmethod
    def from_env(cls) -> Settings:
        limits = Limits(
            max_bytes=int(os.getenv("WDP_MAX_BYTES", "2000000")),
            max_rows=int(os.getenv("WDP_MAX_ROWS", "1000")),
        )
        return cls(
            limits=limits,
            max_sessions=int(os.getenv("WDP_MAX_SESSIONS", "4")),
            ttl_seconds=int(os.getenv("WDP_TTL_SECONDS", "900")),
            requests_per_minute=int(os.getenv("WDP_REQUESTS_PER_MINUTE", "120")),
            concurrent_analyses=int(os.getenv("WDP_CONCURRENT_ANALYSES", "2")),
            cors_origins=tuple(x.strip() for x in os.getenv("WDP_CORS_ORIGINS", "").split(",") if x.strip()),
        )


class ErrorBody(Schema):
    code: str
    message: str


class ErrorResponse(Schema):
    error: ErrorBody


class Health(Schema):
    status: str = "ok"
    version: str = "0.1.0"
    storage: str = "bounded process memory; one worker required"
    dataset_configured: bool = False


class UploadResult(Schema):
    dataset_token: str
    expires_in_seconds: int
    summary: Summary


class TextRequest(Schema):
    text: str = Field(min_length=1, max_length=20_000)
    terms: tuple[Annotated[str, Field(min_length=1, max_length=100)], ...] = Field(default=(), max_length=20)
    options: Options = Options()


class ImportConfig(Schema):
    text_column: str
    label_column: str
    ai_label: str
    human_label: str
    options: Options
    provenance: Provenance


class BodyLimitMiddleware:
    """Cap all actual body bytes, including chunked requests, before JSON parsing."""

    def __init__(self, app: ASGIApp, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                length = int(raw_length)
                if length < 0:
                    raise ValueError
            except ValueError:
                await self.reject(scope, receive, send, 400, "invalid_content_length", "Invalid Content-Length.")
                return
            if length > self.limit:
                await self.reject(scope, receive, send, 413, "request_too_large", "Request exceeds the configured byte limit.")
                return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.limit:
                await self.reject(scope, receive, send, 413, "request_too_large", "Request exceeds the configured byte limit.")
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def reject(scope: Scope, receive: Receive, send: Send, status: int, code: str, message: str) -> None:
        await JSONResponse({"error": {"code": code, "message": message}}, status_code=status)(scope, receive, send)


class DatasetStore:
    """Random bearer handles; no list operation and no global active dataset."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = threading.Lock()
        self.items: dict[str, tuple[float, Corpus]] = {}

    def _prune(self) -> None:
        now = time.monotonic()
        for key in list(self.items):
            if self.items[key][0] <= now:
                del self.items[key]

    def add(self, corpus: Corpus) -> str:
        with self.lock:
            self._prune()
            if len(self.items) >= self.settings.max_sessions:
                raise ResearchError("session_capacity", "Dataset capacity reached; retry after existing sessions expire.", 503)
            token = secrets.token_urlsafe(32)
            self.items[token] = (time.monotonic() + self.settings.ttl_seconds, corpus)
            return token

    def get(self, token: str | None) -> Corpus:
        if not token:
            raise ResearchError("dataset_required", "Upload a dataset and provide its X-Dataset-Token header.", 404)
        with self.lock:
            self._prune()
            item = self.items.get(token)
            if item is None:
                raise ResearchError("dataset_not_found", "Dataset session is unknown or expired; upload it again.", 404)
            return item[1]

    def clear(self) -> None:
        with self.lock:
            self.items.clear()


class Budget:
    """Global process-level safety budget, not a distributed per-user rate limiter."""

    def __init__(self, settings: Settings):
        self.slots = threading.BoundedSemaphore(settings.concurrent_analyses)
        self.lock = threading.Lock()
        self.times: deque[float] = deque()
        self.max_requests = settings.requests_per_minute

    def request(self) -> None:
        now = time.monotonic()
        with self.lock:
            while self.times and self.times[0] <= now - 60:
                self.times.popleft()
            if len(self.times) >= self.max_requests:
                raise ResearchError("rate_limit", "Research request budget exhausted; retry in one minute.", 429)
            self.times.append(now)

    @contextmanager
    def compute(self) -> Iterator[None]:
        if not self.slots.acquire(blocking=False):
            raise ResearchError("analysis_busy", "Analysis capacity is busy; retry shortly.", 503)
        try:
            yield
        finally:
            self.slots.release()


def import_config(
    source_origin: Annotated[str, Query(min_length=1, max_length=500)],
    text_column: Annotated[str, Query(min_length=1, max_length=100)] = "text",
    label_column: Annotated[str, Query(min_length=1, max_length=100)] = "label",
    ai_label: Annotated[str, Query(min_length=1, max_length=100)] = "ai",
    human_label: Annotated[str, Query(min_length=1, max_length=100)] = "human",
    license_info: Annotated[str, Query(max_length=500)] = "Unknown; uploader must check permitted use.",
    collection_version: Annotated[str | None, Query(max_length=200)] = None,
    limitations: Annotated[str, Query(max_length=1000)] = "User-supplied provenance and labels are unverified.",
    lowercase: bool = True,
    keep_numbers: bool = False,
    stop_words: Annotated[list[str] | None, Query(max_length=500)] = None,
) -> ImportConfig:
    # Convert domain validation failures into the public 422 envelope, not 500s.
    from pydantic import ValidationError
    try:
        return ImportConfig(text_column=text_column, label_column=label_column, ai_label=ai_label, human_label=human_label, options=Options(lowercase=lowercase, keep_numbers=keep_numbers, stop_words=tuple(stop_words or ())), provenance=Provenance(source=source_origin, license=license_info, collection_version=collection_version, limitations=limitations))
    except ValidationError as exc:
        raise ResearchError("invalid_configuration", "Invalid provenance or preprocessing configuration.") from exc


DatasetToken = Annotated[str | None, Header(alias="X-Dataset-Token", max_length=100)]
MetadataFilter = Annotated[str | None, Query(min_length=1, max_length=1000)]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store, budget = DatasetStore(settings), Budget(settings)
    errors = {status: {"model": ErrorResponse} for status in (400, 404, 413, 415, 422, 429, 503)}
    app = FastAPI(title="Word Detective Pro — Research API", version="0.1.0", description="Corpus comparison, not authorship detection. No default or fabricated dataset. CSV endpoints accept a raw text/csv body. Uploaded datasets receive an ephemeral bearer handle.", responses=errors)
    app.state.store = store
    app.state.settings = settings
    app.add_middleware(BodyLimitMiddleware, limit=settings.limits.max_bytes)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-Dataset-Token"])

    @app.exception_handler(ResearchError)
    async def domain_error(request: Request, exc: ResearchError) -> JSONResponse:
        headers = {"Retry-After": "60"} if exc.status in (429, 503) else None
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Deliberately omit Pydantic input echoes to avoid exposing submitted text.
        return JSONResponse({"error": {"code": "invalid_request", "message": "Request fields do not match the documented API schema."}}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse({"error": {"code": "http_error", "message": "The requested route or method is unavailable."}}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse({"error": {"code": "internal_error", "message": "Analysis failed unexpectedly. No result was returned."}}, status_code=500)

    def selected(token: str | None, category: str | None, source: str | None, subset: str | None) -> Corpus:
        return select(store.get(token), category=category, source=source, subset=subset)

    def parse(data: bytes, config: ImportConfig) -> Corpus:
        return load_csv(data, config.provenance, text_column=config.text_column, label_column=config.label_column, ai_label=config.ai_label, human_label=config.human_label, options=config.options, limits=settings.limits)

    async def read_csv_body(request: Request) -> bytes:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "text/csv":
            raise ResearchError("unsupported_media_type", "Send raw UTF-8 CSV with Content-Type: text/csv, not multipart.", 415)
        budget.request()
        return await request.body()

    csv_schema = {"requestBody": {"required": True, "content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}}}}

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health()

    @app.post("/api/datasets/validate", response_model=Summary, openapi_extra=csv_schema)
    async def validate_dataset(request: Request, config: Annotated[ImportConfig, Depends(import_config)]) -> Summary:
        data = await read_csv_body(request)
        def work() -> Summary:
            with budget.compute():
                return summary(parse(data, config))
        return await run_in_threadpool(work)

    @app.post("/api/datasets/upload", response_model=UploadResult, status_code=201, openapi_extra=csv_schema)
    async def upload_dataset(request: Request, config: Annotated[ImportConfig, Depends(import_config)]) -> UploadResult:
        data = await read_csv_body(request)
        def work() -> UploadResult:
            with budget.compute():
                corpus = parse(data, config)
                result = summary(corpus)
                token = store.add(corpus)
                return UploadResult(dataset_token=token, expires_in_seconds=settings.ttl_seconds, summary=result)
        return await run_in_threadpool(work)

    @app.get("/api/dataset/summary", response_model=Summary)
    def dataset_summary(dataset_token: DatasetToken = None, category: MetadataFilter = None, source: MetadataFilter = None, subset: MetadataFilter = None) -> Summary:
        budget.request()
        with budget.compute():
            return summary(selected(dataset_token, category, source, subset))

    @app.get("/api/words", response_model=WordPage)
    def words(dataset_token: DatasetToken = None, category: MetadataFilter = None, source: MetadataFilter = None, subset: MetadataFilter = None, offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 50, min_count: Annotated[int, Query(ge=1)] = 1, min_documents: Annotated[int, Query(ge=1)] = 1) -> WordPage:
        budget.request()
        with budget.compute():
            return Analysis(selected(dataset_token, category, source, subset)).page(offset=offset, limit=limit, min_count=min_count, min_documents=min_documents)

    @app.get("/api/words/{word}", response_model=WordReport)
    def word_detail(word: str, dataset_token: DatasetToken = None, category: MetadataFilter = None, source: MetadataFilter = None, subset: MetadataFilter = None, seed: Annotated[int, Query(ge=0, lt=2**32)] = 1729, resamples: Annotated[int, Query(ge=100, le=1000)] = 500) -> WordReport:
        if len(word) > 100:
            raise ResearchError("invalid_word", "Word exceeds 100 characters.")
        budget.request()
        with budget.compute():
            corpus = selected(dataset_token, category, source, subset)
            return WordReport(dataset_version=corpus.dataset_version, analysis_version=corpus.analysis_version, filters=dict(corpus.filters), preprocessing=corpus.options, result=Analysis(corpus).word(word, bootstrap=True, seed=seed, resamples=resamples))

    @app.post("/api/analyze-text", response_model=TextReport)
    def text_analysis(payload: TextRequest, dataset_token: DatasetToken = None) -> TextReport:
        budget.request()
        with budget.compute():
            reference = Analysis(store.get(dataset_token)) if dataset_token else None
            if reference is not None and "options" in payload.model_fields_set and payload.options != reference.corpus.options:
                raise ResearchError("preprocessing_mismatch", "Text preprocessing must match the selected reference dataset.")
            return analyze_text(payload.text, payload.terms, options=payload.options, reference=reference, max_chars=settings.limits.max_text_chars)

    return app


app = create_app()
