"""Deterministic, bounded corpus analysis. Labels describe supplied data, not authorship.

No network, filesystem access, trained models, or implicit datasets are used here.
The CSV loader is replaceable; all analysis consumes the immutable Corpus snapshot.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator
from scipy.stats import fisher_exact

Label = Literal["ai", "human"]
TOKEN = re.compile(r"[^\W_]+(?:'[^\W_]+)*", re.UNICODE)
METHOD_VERSION = "document-bootstrap-fisher-bh-v1"
DISCLOSURE = (
    "Writing-pattern research only. Dataset labels, word frequencies and statistical "
    "differences cannot establish the authorship of an individual text."
)


class ResearchError(ValueError):
    """Safe, public validation failure; never includes submitted text."""

    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Options(Schema):
    lowercase: bool = True
    keep_numbers: bool = False
    stop_words: tuple[str, ...] = Field(default=(), max_length=500)

    @field_validator("stop_words")
    @classmethod
    def canonical_stops(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(len(v) > 100 or TOKEN.fullmatch(v) is None or normalize(v) != v for v in values):
            raise ValueError("Stop words must be individual NFKC-normalized tokens.")
        return tuple(sorted(set(values)))


class Provenance(Schema):
    source: str = Field(min_length=1, max_length=500)
    license: str = Field(default="Unknown; permitted use must be checked by the uploader.", max_length=500)
    collection_version: str | None = Field(default=None, max_length=200)
    limitations: str = Field(default="User-supplied labels and origin are not independently verified.", max_length=1000)

    @field_validator("source")
    @classmethod
    def nonblank_source(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("An origin description is required.")
        return value.strip()


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 2_000_000
    max_rows: int = 1000
    max_columns: int = 30
    max_text_chars: int = 20_000
    max_tokens: int = 200_000
    max_vocabulary: int = 10_000

    def __post_init__(self) -> None:
        if any(value <= 0 for value in vars(self).values()):
            raise ValueError("All limits must be positive.")


@dataclass(frozen=True)
class Document:
    label: Label
    tokens: tuple[str, ...]
    identity: str
    category: str | None
    source: str | None
    subset: str | None


@dataclass(frozen=True)
class Corpus:
    documents: tuple[Document, ...]
    dataset_version: str
    analysis_version: str
    options: Options
    provenance: Provenance
    columns: tuple[str, ...]
    label_definitions: dict[str, str]
    filters: tuple[tuple[str, str], ...] = ()


class GroupSummary(Schema):
    documents: int
    total_tokens: int
    min_tokens: int
    median_tokens: float
    max_tokens: int


class Summary(Schema):
    dataset_version: str
    analysis_version: str
    methodology_version: str = METHOD_VERSION
    rows: int
    columns: tuple[str, ...]
    missing_values: int
    duplicate_documents: int
    conflicting_label_documents: int
    groups: dict[str, GroupSummary]
    metadata_counts: dict[str, dict[str, dict[str, int]]]
    filters: dict[str, str]
    preprocessing: Options
    provenance: Provenance
    label_definitions: dict[str, str]
    warnings: list[str]
    disclosure: str = DISCLOSURE


class Interval(Schema):
    lower: float
    upper: float
    confidence: float = 0.95
    method: str


class GroupWord(Schema):
    occurrences: int
    documents_containing: int
    documents: int
    total_tokens: int
    token_probability: float | None
    per_1000_tokens: float | None
    document_prevalence: float | None
    prevalence_interval: Interval | None = None
    frequency_interval: Interval | None = None


class WordResult(Schema):
    word: str
    groups: dict[str, GroupWord]
    difference_per_1000: float | None
    absolute_difference_per_1000: float | None
    frequency_ratio_ai_over_human: float | None
    ratio_method: str = "Unsmoothed; undefined when the human frequency is zero or either token total is zero."
    difference_interval: Interval | None = None
    p_value: float | None = None
    q_value: float | None = None
    tested_words: int = 0
    test: str = "Two-sided Fisher exact test of document presence; BH adjustment over the entire selected vocabulary."
    uncertainty_note: str


class WordPage(Schema):
    dataset_version: str
    analysis_version: str
    filters: dict[str, str]
    total: int
    offset: int
    limit: int
    items: list[WordResult]
    disclosure: str = DISCLOSURE


class WordReport(Schema):
    dataset_version: str
    analysis_version: str
    filters: dict[str, str]
    preprocessing: Options
    result: WordResult
    disclosure: str = DISCLOSURE


class TermResult(Schema):
    word: str
    count: int
    per_1000_tokens: float | None
    reference: WordResult | None


class TextReport(Schema):
    character_count: int
    token_count: int
    sentence_count_heuristic: int
    average_word_length: float | None
    vocabulary_diversity: float | None
    definitions: str = "Character count uses Unicode code points. Diversity = unique analysis tokens / analysis tokens. Sentence count is a punctuation heuristic, not a linguistic parser."
    terms: list[TermResult]
    preprocessing: Options
    dataset_version: str | None
    analysis_version: str | None
    disclosure: str = DISCLOSURE


def normalize(text: str, lowercase: bool = False) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\u2019", "'").replace("\u2018", "'")
    return unicodedata.normalize("NFKC", text.casefold()) if lowercase else text


def tokenize(text: str, options: Options = Options()) -> tuple[str, ...]:
    stops = {normalize(s, options.lowercase) for s in options.stop_words}
    return tuple(
        token for token in TOKEN.findall(normalize(text, options.lowercase))
        if (options.keep_numbers or not token.isnumeric()) and token not in stops
    )


def single_word(word: str, options: Options) -> str:
    tokens = tokenize(word, options)
    if len(tokens) != 1:
        raise ResearchError("invalid_word", "Choose one token retained by the preprocessing options.")
    return tokens[0]


def load_csv(
    data: bytes, provenance: Provenance, *, text_column: str = "text",
    label_column: str = "label", ai_label: str = "ai", human_label: str = "human",
    options: Options = Options(), limits: Limits = Limits(),
) -> Corpus:
    """Read strict UTF-8 CSV with unique headers; never infer labels or discard rows.

    Optional columns category, source and subset are literal user-provided metadata.
    Dataset version hashes input bytes; analysis version also covers configuration.
    """
    if len(data) > limits.max_bytes:
        raise ResearchError("upload_too_large", "CSV exceeds the configured byte limit.", 413)
    if not data:
        raise ResearchError("empty_dataset", "CSV is empty.")
    if ai_label == human_label or not ai_label.strip() or not human_label.strip():
        raise ResearchError("invalid_mapping", "Two distinct, nonblank labels are required.")
    if text_column == label_column or {text_column, label_column} & {"source", "category", "subset"}:
        raise ResearchError("invalid_columns", "Text and label columns must be distinct and cannot use reserved metadata names.")
    try:
        text = data.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise ResearchError("invalid_encoding", "CSV must use UTF-8 encoding.") from exc
    if "\x00" in text:
        raise ResearchError("malformed_csv", "CSV cannot contain NUL characters.")
    documents: list[Document] = []
    vocabulary: set[str] = set()
    token_total = 0
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        headers = next(reader, [])
        if not headers:
            raise ResearchError("empty_dataset", "CSV must include a header and data rows.")
        if len(headers) > limits.max_columns:
            raise ResearchError("too_many_columns", "CSV exceeds the column limit.")
        if len(set(headers)) != len(headers) or any(not h.strip() or h != h.strip() or len(h) > 100 or any(ord(c) < 32 for c in h) for h in headers):
            raise ResearchError("invalid_headers", "Headers must be unique, nonblank, trimmed names of at most 100 characters without control characters.")
        if text_column not in headers or label_column not in headers:
            raise ResearchError("missing_columns", "The configured text and label columns must exist.")
        for number, cells in enumerate(reader, start=2):
            if len(documents) >= limits.max_rows:
                raise ResearchError("too_many_rows", "CSV exceeds the row limit.", 413)
            if len(cells) != len(headers):
                raise ResearchError("malformed_csv", f"Record {number} has the wrong number of fields.")
            if any(not cell.strip() for cell in cells):
                raise ResearchError("missing_values", f"Record {number} contains a missing value; no rows were imported.")
            row = dict(zip(headers, cells, strict=True))
            raw = row[text_column]
            if len(raw) > limits.max_text_chars:
                raise ResearchError("text_too_long", f"Record {number} exceeds the text character limit.", 413)
            if row[label_column] not in (ai_label, human_label):
                raise ResearchError("invalid_labels", f"Record {number} has an unmapped label.")
            tokens = tokenize(raw, options)
            if not tokens:
                raise ResearchError("empty_tokens", f"Record {number} has no tokens after preprocessing.")
            if any(len(token) > 100 for token in tokens):
                raise ResearchError("token_too_long", f"Record {number} contains a token longer than 100 characters.")
            token_total += len(tokens)
            vocabulary.update(tokens)
            if token_total > limits.max_tokens or len(vocabulary) > limits.max_vocabulary:
                raise ResearchError("analysis_limit", "CSV exceeds the token or vocabulary limit.", 413)
            identity = hashlib.sha256(" ".join(normalize(raw, True).split()).encode()).hexdigest()
            documents.append(Document(
                "ai" if row[label_column] == ai_label else "human", tokens, identity,
                row.get("category"), row.get("source"), row.get("subset"),
            ))
    except csv.Error as exc:
        raise ResearchError("malformed_csv", "CSV parsing failed; check quoting and field sizes.") from exc
    if not documents:
        raise ResearchError("empty_dataset", "CSV contains no documents.")
    if {d.label for d in documents} != {"ai", "human"}:
        raise ResearchError("missing_group", "The imported dataset must contain both mapped label groups.")
    version = hashlib.sha256(data).hexdigest()
    config = json.dumps({"options": options.model_dump(), "columns": [text_column, label_column], "labels": [ai_label, human_label], "provenance": provenance.model_dump(), "method": METHOD_VERSION}, sort_keys=True)
    analysis = hashlib.sha256((version + config).encode()).hexdigest()
    return Corpus(tuple(documents), version, analysis, options, provenance, tuple(headers), {"ai": ai_label, "human": human_label})


def select(corpus: Corpus, **filters: str | None) -> Corpus:
    """Filter metadata without interpreting a subset name as a held-out evaluation."""
    if set(filters) - {"category", "source", "subset"}:
        raise ResearchError("invalid_filter", "Unsupported metadata filter.")
    selected = {k: v for k, v in filters.items() if v is not None}
    if any(k not in corpus.columns for k in selected):
        raise ResearchError("unavailable_metadata", "A requested metadata column is unavailable.")
    docs = tuple(d for d in corpus.documents if all(getattr(d, k) == v for k, v in selected.items()))
    combined = dict(corpus.filters) | selected
    version = hashlib.sha256((corpus.analysis_version + json.dumps(selected, sort_keys=True)).encode()).hexdigest() if selected else corpus.analysis_version
    return Corpus(docs, corpus.dataset_version, version, corpus.options, corpus.provenance, corpus.columns, corpus.label_definitions, tuple(sorted(combined.items())))


def duplicate_counts(corpus: Corpus) -> tuple[int, int]:
    identities: dict[str, list[str]] = {}
    for doc in corpus.documents:
        identities.setdefault(doc.identity, []).append(doc.label)
    return sum(len(labels) - 1 for labels in identities.values()), sum(len(labels) for labels in identities.values() if len(set(labels)) > 1)


def summary(corpus: Corpus) -> Summary:
    groups = {}
    for label in ("ai", "human"):
        lengths = [len(d.tokens) for d in corpus.documents if d.label == label]
        groups[label] = GroupSummary(documents=len(lengths), total_tokens=sum(lengths), min_tokens=min(lengths, default=0), median_tokens=float(np.median(lengths)) if lengths else 0.0, max_tokens=max(lengths, default=0))
    metadata: dict[str, dict[str, dict[str, int]]] = {}
    for field in ("category", "source", "subset"):
        if field in corpus.columns:
            metadata[field] = {}
            for doc in corpus.documents:
                value = getattr(doc, field)
                counts = metadata[field].setdefault(value, {"ai": 0, "human": 0})
                counts[doc.label] += 1
    duplicates, conflicts = duplicate_counts(corpus)
    warnings = ["Labels and provenance are user supplied; no authorship or generalization claims are supported.", "Near-duplicate, author, prompt and collection-cluster dependence is not detected."]
    if "source" not in corpus.columns:
        warnings.append("Source-level bias cannot be evaluated: source metadata is unavailable.")
    if duplicates:
        warnings.append("Duplicate normalized text detected; statistical inference is disabled. Counts retain all rows.")
    if any(group.documents < 10 for group in groups.values()):
        warnings.append("One or both groups have fewer than 10 documents; inference is disabled.")
    if any(min(counts.values()) < 10 for values in metadata.values() for counts in values.values()):
        warnings.append("Some metadata subgroups are missing a class or have fewer than 10 documents per class.")
    return Summary(dataset_version=corpus.dataset_version, analysis_version=corpus.analysis_version, rows=len(corpus.documents), columns=corpus.columns, missing_values=0, duplicate_documents=duplicates, conflicting_label_documents=conflicts, groups=groups, metadata_counts=metadata, filters=dict(corpus.filters), preprocessing=corpus.options, provenance=corpus.provenance, label_definitions=corpus.label_definitions, warnings=warnings)


def benjamini_hochberg(p_values: list[float]) -> list[float]:
    """BH adjusted p-values in input order, using the complete tested family."""
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in p_values):
        raise ValueError("p-values must be finite and between zero and one.")
    if not p_values:
        return []
    order = np.argsort(p_values)
    ranked = np.asarray(p_values)[order] * len(p_values) / np.arange(1, len(p_values) + 1)
    adjusted = np.minimum.accumulate(ranked[::-1])[::-1].clip(0, 1)
    result = np.empty(len(p_values))
    result[order] = adjusted
    return result.tolist()


def wilson(successes: int, total: int) -> Interval:
    """95% Wilson score interval with documents (not tokens) as Bernoulli units."""
    if total <= 0 or not 0 <= successes <= total:
        raise ValueError("Wilson interval requires valid document counts.")
    z = 1.959963984540054
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return Interval(lower=max(0.0, center - half), upper=min(1.0, center + half), method="Wilson document-prevalence interval; assumes independent documents")


class Analysis:
    """One selected corpus; aggregate once and adjust over its full vocabulary."""

    def __init__(self, corpus: Corpus):
        self.corpus = corpus
        self.docs = {label: tuple(d for d in corpus.documents if d.label == label) for label in ("ai", "human")}
        self.counts = {label: Counter(t for d in docs for t in d.tokens) for label, docs in self.docs.items()}
        self.presence = {label: Counter(t for d in docs for t in set(d.tokens)) for label, docs in self.docs.items()}
        self.totals = {label: sum(counts.values()) for label, counts in self.counts.items()}
        self.vocabulary = sorted(set(self.counts["ai"]) | set(self.counts["human"]))
        self.inference = all(len(docs) >= 10 for docs in self.docs.values()) and duplicate_counts(corpus)[0] == 0
        self.p_values: dict[str, float] = {}
        self.q_values: dict[str, float] = {}
        if self.inference:
            for word in self.vocabulary:
                a, h = self.presence["ai"][word], self.presence["human"][word]
                self.p_values[word] = float(fisher_exact([[a, len(self.docs["ai"]) - a], [h, len(self.docs["human"]) - h]]).pvalue)
            self.q_values = dict(zip(self.vocabulary, benjamini_hochberg(list(self.p_values.values())), strict=True))

    def word(self, word: str, *, bootstrap: bool = False, seed: int = 1729, resamples: int = 500) -> WordResult:
        word = single_word(word, self.corpus.options)
        if not 100 <= resamples <= 1000 or not 0 <= seed < 2**32:
            raise ResearchError("invalid_resampling", "Use 100–1000 resamples and a nonnegative 32-bit seed.")
        groups = {}
        for label in ("ai", "human"):
            n, total = len(self.docs[label]), self.totals[label]
            count, presence = self.counts[label][word], self.presence[label][word]
            groups[label] = GroupWord(occurrences=count, documents_containing=presence, documents=n, total_tokens=total, token_probability=count / total if total else None, per_1000_tokens=1000 * count / total if total else None, document_prevalence=presence / n if n else None, prevalence_interval=wilson(presence, n) if self.inference else None)
        ai, human = groups["ai"].per_1000_tokens, groups["human"].per_1000_tokens
        difference = ai - human if ai is not None and human is not None else None
        ratio = ai / human if ai is not None and human is not None and human > 0 else None
        note = "Inference unavailable: each group needs at least 10 documents and no normalized-text duplicates."
        interval = None
        if self.inference:
            note = "Prevalence inference assumes independent documents. Token-frequency bootstrap is computed only on word detail, with at least 5 supporting documents and variable document rates in each group. BH requires independence or suitable positive dependence; correlated vocabulary and exploratory filtering limit interpretation."
            if bootstrap:
                samples: dict[str, np.ndarray] = {}
                rng = np.random.default_rng(seed)
                for label, docs in self.docs.items():
                    counts = np.array([d.tokens.count(word) for d in docs], dtype=float)
                    lengths = np.array([len(d.tokens) for d in docs], dtype=float)
                    if self.presence[label][word] < 5 or np.ptp(counts / lengths) == 0:
                        break
                    # Resample whole documents within each group; preserve length weighting.
                    values = np.empty(resamples)
                    for index in range(resamples):
                        draw = rng.integers(0, len(docs), size=len(docs))
                        values[index] = 1000 * counts[draw].sum() / lengths[draw].sum()
                    samples[label] = values
                if len(samples) == 2:
                    method = f"Stratified whole-document percentile bootstrap; B={resamples}, seed={seed}; marginal 95%, not simultaneous"
                    for label in ("ai", "human"):
                        lo, hi = np.quantile(samples[label], [0.025, 0.975])
                        groups[label] = groups[label].model_copy(update={"frequency_interval": Interval(lower=float(lo), upper=float(hi), method=method)})
                    lo, hi = np.quantile(samples["ai"] - samples["human"], [0.025, 0.975])
                    interval = Interval(lower=float(lo), upper=float(hi), method=method)
                else:
                    note += " Frequency intervals withheld: insufficient support or degenerate observed document rates."
        return WordResult(word=word, groups=groups, difference_per_1000=difference, absolute_difference_per_1000=abs(difference) if difference is not None else None, frequency_ratio_ai_over_human=ratio, difference_interval=interval, p_value=self.p_values.get(word), q_value=self.q_values.get(word), tested_words=len(self.p_values), uncertainty_note=note)

    def page(self, *, offset: int = 0, limit: int = 50, min_count: int = 1, min_documents: int = 1) -> WordPage:
        if offset < 0 or not 1 <= limit <= 100 or min_count < 1 or min_documents < 1:
            raise ResearchError("invalid_pagination", "Invalid page or support thresholds.")
        words = [w for w in self.vocabulary if sum(self.counts[g][w] for g in ("ai", "human")) >= min_count and sum(self.presence[g][w] for g in ("ai", "human")) >= min_documents]
        def effect(word: str) -> float:
            if not all(self.totals.values()):
                return 0.0
            return abs(self.counts["ai"][word] / self.totals["ai"] - self.counts["human"][word] / self.totals["human"])
        words.sort(key=lambda w: (-effect(w), w))
        return WordPage(dataset_version=self.corpus.dataset_version, analysis_version=self.corpus.analysis_version, filters=dict(self.corpus.filters), total=len(words), offset=offset, limit=limit, items=[self.word(w) for w in words[offset:offset + limit]])


def analyze_text(text: str, terms: tuple[str, ...] = (), *, options: Options = Options(), reference: Analysis | None = None, max_chars: int = 20_000) -> TextReport:
    if len(text) > max_chars:
        raise ResearchError("text_too_long", "Text exceeds the character limit.", 413)
    if not text.strip():
        raise ResearchError("empty_text", "Enter nonblank text.")
    if reference is not None:
        options = reference.corpus.options
    tokens = tokenize(text, options)
    counts = Counter(tokens)
    if len(terms) > 20:
        raise ResearchError("too_many_terms", "Select at most 20 terms.")
    selected = list(dict.fromkeys(single_word(term, options) for term in terms))
    return TextReport(character_count=len(text), token_count=len(tokens), sentence_count_heuristic=len([s for s in re.split(r"[.!?。！？]+", text) if any(c.isalnum() for c in s)]), average_word_length=sum(map(len, tokens)) / len(tokens) if tokens else None, vocabulary_diversity=len(counts) / len(tokens) if tokens else None, terms=[TermResult(word=w, count=counts[w], per_1000_tokens=1000 * counts[w] / len(tokens) if tokens else None, reference=reference.word(w) if reference else None) for w in selected], preprocessing=options, dataset_version=reference.corpus.dataset_version if reference else None, analysis_version=reference.corpus.analysis_version if reference else None)
