"""HTTP contracts and safety tests; constructed fixtures are not research evidence."""
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
def client():
    with TestClient(create_app()) as instance:
        yield instance


def upload(client, data=CSV, **params):
    return client.post("/api/datasets/upload", content=data, headers=CSV_HEADERS, params=PARAMS | params)


def token_headers(client):
    response = upload(client)
    assert response.status_code == 201, response.text
    return {"X-Dataset-Token": response.json()["dataset_token"]}


def test_health_and_openapi(client):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/health").json()["dataset_configured"] is False
    schema = client.get("/openapi.json")
    assert schema.status_code == 200
    content = schema.json()["paths"]["/api/datasets/upload"]["post"]["requestBody"]["content"]
    assert "text/csv" in content
    assert "WordReport" in schema.json()["components"]["schemas"]


def test_validate_does_not_store_and_upload_returns_real_summary(client):
    result = client.post("/api/datasets/validate", content=CSV, headers=CSV_HEADERS, params=PARAMS)
    assert result.status_code == 200
    assert Summary.model_validate(result.json()).rows == 2
    assert client.app.state.store.items == {}
    response = upload(client)
    assert response.status_code == 201
    payload = response.json()
    assert payload["expires_in_seconds"] == 900
    assert len(payload["dataset_token"]) >= 40
    assert payload["summary"]["groups"]["ai"]["total_tokens"] == 3
    assert len(client.app.state.store.items) == 1


def test_word_endpoints_and_response_contracts(client):
    headers = token_headers(client)
    listing = client.get("/api/words", headers=headers, params={"limit": 1})
    assert listing.status_code == 200
    page = WordPage.model_validate(listing.json())
    assert page.total == 2
    assert len(page.items) == 1
    response = client.get("/api/words/cat", headers=headers)
    assert response.status_code == 200
    report = WordReport.model_validate(response.json())
    assert report.result.groups["ai"].per_1000_tokens == pytest.approx(2000 / 3)
    assert report.result.groups["human"].occurrences == 0
    assert report.result.frequency_ratio_ai_over_human is None
    assert report.result.p_value is None
    assert report.result.difference_interval is None
    assert client.get("/api/words", headers=headers, params={"min_count": 99}).json()["items"] == []
    assert client.get("/api/words", headers=headers, params={"category": "absent"}).json()["total"] == 0
    stats = client.get("/api/dataset/summary", headers=headers)
    assert Summary.model_validate(stats.json()).rows == 2


def test_missing_unknown_and_expired_sessions(client):
    assert client.get("/api/words").status_code == 404
    assert client.get("/api/words", headers={"X-Dataset-Token": "unknown"}).status_code == 404
    headers = token_headers(client)
    token = headers["X-Dataset-Token"]
    expires, corpus = client.app.state.store.items[token]
    assert expires > time.monotonic()
    client.app.state.store.items[token] = (0, corpus)
    response = client.get("/api/words", headers=headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "dataset_not_found"
    assert not client.app.state.store.items


@pytest.mark.parametrize(("data", "code"), [
    (b"", "empty_dataset"),
    (b"text,label\n", "empty_dataset"),
    (b"text,label\nx,wrong", "invalid_labels"),
    (b"text,label\n,ai", "missing_values"),
    (b'text,label\n"unfinished,ai', "malformed_csv"),
    (b"text,label\n\xff,ai", "invalid_encoding"),
    (b"other,label\nx,ai", "missing_columns"),
])
def test_invalid_uploads_rejected_atomically(client, data, code):
    response = upload(client, data)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code
    assert client.app.state.store.items == {}


def test_upload_media_type_and_required_provenance(client):
    assert client.post("/api/datasets/upload", content=CSV, params=PARAMS).status_code == 415
    assert client.post("/api/datasets/upload", content=CSV, headers=CSV_HEADERS).status_code == 422
    assert upload(client, source_origin=" ").status_code == 422
    assert upload(client, stop_words="two words").status_code == 422
    assert upload(client, ai_label="same", human_label="same").status_code == 422


def test_oversized_csv_and_json():
    with TestClient(create_app(Settings(limits=Limits(max_bytes=64)))) as instance:
        assert upload(instance, b"x" * 65).status_code == 413
        response = instance.post("/api/analyze-text", json={"text": "x" * 65})
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "request_too_large"


def test_row_limit():
    with TestClient(create_app(Settings(limits=Limits(max_rows=1)))) as instance:
        assert upload(instance).status_code == 413


def test_chunked_body_limit_without_content_length():
    called = False
    sent = []
    messages = iter([
        {"type": "http.request", "body": b"123", "more_body": True},
        {"type": "http.request", "body": b"456", "more_body": False},
    ])

    async def inner(scope, receive, send):
        nonlocal called
        called = True

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    asyncio.run(BodyLimitMiddleware(inner, 5)({"type": "http", "headers": []}, receive, send))
    assert not called
    assert sent[0]["status"] == 413


def test_malformed_content_length(client):
    response = client.post("/api/analyze-text", content=b"{}", headers={"Content-Length": "not-a-number", "Content-Type": "application/json"})
    assert response.status_code == 400


def test_text_analysis_no_dataset_and_with_reference(client):
    response = client.post("/api/analyze-text", json={"text": "Cat cat! Dog?", "terms": ["cat"]})
    assert response.status_code == 200
    report = TextReport.model_validate(response.json())
    assert report.token_count == 3
    assert report.terms[0].reference is None
    headers = token_headers(client)
    response = client.post("/api/analyze-text", headers=headers, json={"text": "Cat", "terms": ["cat"]})
    report = TextReport.model_validate(response.json())
    assert report.terms[0].reference.groups["ai"].occurrences == 2
    assert report.dataset_version is not None
    assert len(client.app.state.store.items) == 1
    mismatch = client.post("/api/analyze-text", headers=headers, json={"text": "Cat", "options": {"lowercase": False}})
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "preprocessing_mismatch"


@pytest.mark.parametrize("payload", [
    {"text": ""}, {"text": " "}, {"text": 123}, {"text": "ok", "unexpected": True},
    {"text": "x" * 20_001}, {"text": "ok", "terms": ["word"] * 21},
    {"text": "ok", "terms": ["two words"]},
])
def test_text_input_validation(client, payload):
    assert client.post("/api/analyze-text", json=payload).status_code == 422


def test_json_error_does_not_echo_sensitive_input(client):
    secret_text = "PRIVATE-INPUT-DO-NOT-ECHO"
    response = client.post("/api/analyze-text", json={"text": {"private": secret_text}})
    assert response.status_code == 422
    assert secret_text not in response.text
    malformed = client.post("/api/analyze-text", content='{"text":', headers={"Content-Type": "application/json"})
    assert malformed.status_code == 422
    assert "error" in malformed.json()


@pytest.mark.parametrize("path", ["/api/words?limit=101", "/api/words?offset=-1", "/api/words/cat?resamples=1", "/api/words/cat?seed=-1", "/api/words?source=missing"])
def test_query_validation(client, path):
    assert client.get(path, headers=token_headers(client)).status_code == 422


def test_capacity_and_session_isolation():
    with TestClient(create_app(Settings(max_sessions=1))) as instance:
        headers = token_headers(instance)
        assert upload(instance).status_code == 503
        assert instance.get("/api/words", headers=headers).status_code == 200
    with TestClient(create_app()) as other:
        assert other.get("/api/words", headers=headers).status_code == 404


def test_global_request_budget_keeps_health_available():
    with TestClient(create_app(Settings(requests_per_minute=1))) as instance:
        assert instance.post("/api/analyze-text", json={"text": "ok"}).status_code == 200
        response = instance.post("/api/analyze-text", json={"text": "ok"})
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "60"
        assert instance.get("/api/health").status_code == 200


def test_concurrent_compute_limit_and_release():
    budget = Budget(Settings(concurrent_analyses=1))
    with budget.compute():
        with pytest.raises(ResearchError) as error:
            with budget.compute():
                pass
        assert error.value.status == 503
    with budget.compute():
        pass


def test_cors_is_explicit_and_no_credentials():
    with TestClient(create_app(Settings(cors_origins=("http://localhost:5173",)))) as instance:
        allowed = instance.options("/api/analyze-text", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type,X-Dataset-Token"})
        assert allowed.status_code == 200
        assert allowed.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
        assert "Access-Control-Allow-Credentials" not in allowed.headers
        blocked = instance.options("/api/analyze-text", headers={"Origin": "https://untrusted.invalid", "Access-Control-Request-Method": "POST"})
        assert blocked.status_code == 400
        assert "Access-Control-Allow-Origin" not in blocked.headers
    with pytest.raises(ValueError):
        Settings(cors_origins=("*",))
    with pytest.raises(ValueError):
        Settings(ttl_seconds=0)


def test_safe_unexpected_error_and_unknown_route():
    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as instance:
        headers = token_headers(instance)
        def broken(token):
            raise RuntimeError("private implementation detail")
        app.state.store.get = broken
        response = instance.get("/api/words", headers=headers)
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "internal_error"
        assert "private implementation detail" not in response.text
        assert instance.get("/unknown").status_code == 404


def test_store_clear_and_normalized_not_raw_retention():
    store = DatasetStore(Settings())
    corpus = load_csv(CSV, Provenance(source="Constructed fixture"))
    token = store.add(corpus)
    assert not hasattr(store.get(token).documents[0], "text")
    store.clear()
    with pytest.raises(ResearchError):
        store.get(token)


def test_deployment_limits_from_environment(monkeypatch):
    monkeypatch.setenv("WDP_REQUESTS_PER_MINUTE", "45")
    monkeypatch.setenv("WDP_CONCURRENT_ANALYSES", "1")
    settings = Settings.from_env()
    assert settings.requests_per_minute == 45
    assert settings.concurrent_analyses == 1


def test_deployment_limit_defaults(monkeypatch):
    monkeypatch.delenv("WDP_REQUESTS_PER_MINUTE", raising=False)
    monkeypatch.delenv("WDP_CONCURRENT_ANALYSES", raising=False)
    settings = Settings.from_env()
    assert settings.requests_per_minute == 120
    assert settings.concurrent_analyses == 2


def test_wildcard_cors_origin_is_rejected():
    with pytest.raises(ValueError, match="CORS origins"):
        Settings(cors_origins=("*",))
