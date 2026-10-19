"""Characterization tests use constructed fixtures, never research evidence."""
import csv
import io

import pytest
from pydantic import ValidationError

from word_detective.core import (
    Analysis, Limits, Options, Provenance, ResearchError, analyze_text,
    benjamini_hochberg, load_csv, normalize, select, summary, tokenize, wilson,
)

ORIGIN = Provenance(source="Constructed unit-test fixture; not research evidence")
SMALL = b"text,label\ncat cat dog,ai\ndog,human\n"


def corpus(data=SMALL, **kwargs):
    return load_csv(data, ORIGIN, **kwargs)


def supported():
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["text", "label", "category", "source", "subset"])
    for label in ("ai", "human"):
        for i in range(20):
            # Unique documents, variable lengths and target rates in both groups.
            count = (i % 3 + 1) if label == "ai" else (i % 2)
            writer.writerow([("target " * count) + ("other " * (i % 4 + 1)) + f"record{label}{i}", label, "test", label + "-fixture", "test-fixture"])
    return corpus(stream.getvalue().encode())


@pytest.mark.parametrize(("text", "expected"), [
    ("Hello, WORLD!", ("hello", "world")),
    ("Don’t stop; can't.", ("don't", "stop", "can't")),
    ("１２３ 42 3.14 item2", ("item2",)),
    ("cafe\u0301 CAFÉ Straße", ("café", "café", "strasse")),
    ("你好 世界", ("你好", "世界")),
    ("", ()),
    ("?! -- ___", ()),
    ("word word word", ("word", "word", "word")),
])
def test_tokenization(text, expected):
    assert tokenize(text) == expected


def test_options_are_explicit():
    assert tokenize("The cat １２", Options(stop_words=("the",), keep_numbers=True)) == ("cat", "12")
    assert tokenize("Cat cat", Options(lowercase=False)) == ("Cat", "cat")
    assert Options(stop_words=("cat", "cat")).stop_words == ("cat",)
    with pytest.raises(ValidationError):
        Options(stop_words=("two words",))
    assert normalize("cafe\u0301") == "café"


def test_loader_summary_and_no_invented_provenance():
    result = summary(corpus())
    assert result.rows == 2
    assert result.groups["ai"].total_tokens == 3
    assert result.groups["human"].documents == 1
    assert result.missing_values == 0
    assert result.provenance == ORIGIN
    assert result.metadata_counts == {}
    assert any("Source-level bias" in warning for warning in result.warnings)


@pytest.mark.parametrize(("data", "code"), [
    (b"", "empty_dataset"),
    (b"text,label\n", "empty_dataset"),
    (b"other,label\nx,ai", "missing_columns"),
    (b"text,text,label\nx,y,ai", "invalid_headers"),
    (b" text,label\nx,ai", "invalid_headers"),
    (b"text,label\nx,bot", "invalid_labels"),
    (b"text,label\n,ai", "missing_values"),
    (b"text,label\nx,ai,extra", "malformed_csv"),
    (b'text,label\n"unclosed,ai', "malformed_csv"),
    (b"text,label\n\xff,ai", "invalid_encoding"),
    (b"text,label\nx\x00,ai", "malformed_csv"),
    (b"text,label\nx,ai", "missing_group"),
    (b"text,label\n!!!,ai", "empty_tokens"),
    (b"text,label\n" + b"x" * 101 + b",ai", "token_too_long"),
])
def test_invalid_csv(data, code):
    with pytest.raises(ResearchError) as error:
        corpus(data)
    assert error.value.code == code


@pytest.mark.parametrize("limits", [
    Limits(max_bytes=10), Limits(max_rows=1), Limits(max_columns=1),
    Limits(max_text_chars=2), Limits(max_tokens=2), Limits(max_vocabulary=1),
])
def test_loader_limits(limits):
    with pytest.raises(ResearchError):
        corpus(limits=limits)


def test_invalid_limits():
    with pytest.raises(ValueError):
        Limits(max_rows=0)


def test_custom_mapping_and_bom_and_quoted_csv():
    data = '\ufeffbody,class\n"Hello, friend",generated\n"Goodbye\nfriend",person\n'.encode()
    result = corpus(data, text_column="body", label_column="class", ai_label="generated", human_label="person")
    assert result.label_definitions == {"ai": "generated", "human": "person"}
    assert len(result.documents) == 2
    with pytest.raises(ResearchError):
        corpus(ai_label="same", human_label="same")
    with pytest.raises(ResearchError):
        corpus(text_column="label")


def test_exact_token_frequency_and_prevalence():
    result = Analysis(corpus()).word("cat")
    assert result.groups["ai"].occurrences == 2
    assert result.groups["ai"].documents_containing == 1
    assert result.groups["ai"].token_probability == pytest.approx(2 / 3)
    assert result.groups["ai"].per_1000_tokens == pytest.approx(2000 / 3)
    assert result.groups["ai"].document_prevalence == 1
    assert result.groups["human"].occurrences == 0
    assert result.frequency_ratio_ai_over_human is None
    assert result.difference_per_1000 == pytest.approx(2000 / 3)
    assert result.absolute_difference_per_1000 == pytest.approx(2000 / 3)
    assert result.p_value is None
    assert result.difference_interval is None
    dog = Analysis(corpus()).word("dog")
    assert dog.frequency_ratio_ai_over_human == pytest.approx(1 / 3)
    assert dog.difference_per_1000 < 0
    absent = Analysis(corpus()).word("absent")
    assert absent.groups["ai"].occurrences == 0
    assert absent.frequency_ratio_ai_over_human is None


def test_bh_known_values_and_order():
    assert benjamini_hochberg([0.01, 0.04, 0.03, 0.002]) == pytest.approx([0.02, 0.04, 0.04, 0.008])
    assert benjamini_hochberg([]) == []
    assert benjamini_hochberg([1, 0, 1]) == [1, 0, 1]
    with pytest.raises(ValueError):
        benjamini_hochberg([float("nan")])


def test_wilson_known_bounds():
    interval = wilson(5, 10)
    assert interval.lower == pytest.approx(0.236593, abs=1e-6)
    assert interval.upper == pytest.approx(0.763407, abs=1e-6)
    assert wilson(0, 10).upper > 0
    with pytest.raises(ValueError):
        wilson(1, 0)


def test_document_bootstrap_reproducible_and_non_degenerate():
    analysis = Analysis(supported())
    first = analysis.word("target", bootstrap=True)
    second = analysis.word("target", bootstrap=True)
    assert first == second
    assert first.difference_interval is not None
    assert first.difference_interval.upper > first.difference_interval.lower
    assert first.groups["ai"].frequency_interval is not None
    assert first.groups["human"].prevalence_interval is not None
    assert 0 <= first.p_value <= first.q_value <= 1
    assert first.tested_words == len(analysis.vocabulary)
    assert analysis.word("missing", bootstrap=True).difference_interval is None
    filtered = analysis.page(min_count=10)
    assert next(item for item in filtered.items if item.word == "target").q_value == first.q_value
    with pytest.raises(ResearchError):
        analysis.word("target", resamples=1)


def test_fisher_reference_value():
    data = "text,label\n" + "\n".join([f"target a{i},ai" for i in range(10)] + [f"other h{i},human" for i in range(10)])
    value = Analysis(corpus(data.encode())).word("target").p_value
    assert value == pytest.approx(1.082508822446903e-5)


def test_duplicates_disable_inference_and_conflicts_reported():
    data = b"text,label\nSame text,ai\nsame   text,human\n"
    result = summary(corpus(data))
    assert result.duplicate_documents == 1
    assert result.conflicting_label_documents == 2
    assert Analysis(corpus(data)).word("same").p_value is None
    large = b"text,label\n" + b"same,ai\n" * 10 + b"same,human\n" * 10
    assert not Analysis(corpus(large)).inference


def test_versions_and_metadata_filters():
    base = supported()
    assert base.dataset_version == supported().dataset_version
    assert base.analysis_version == supported().analysis_version
    assert corpus(options=Options(keep_numbers=True)).analysis_version != corpus().analysis_version
    assert corpus(options=Options(keep_numbers=True)).dataset_version == corpus().dataset_version
    stats = summary(base)
    assert stats.metadata_counts["category"]["test"] == {"ai": 20, "human": 20}
    one_class = select(base, source="ai-fixture")
    assert summary(one_class).groups["human"].documents == 0
    assert Analysis(one_class).word("target").difference_per_1000 is None
    empty = select(base, category="not-present")
    assert Analysis(empty).page().items == []
    assert empty.analysis_version != base.analysis_version
    with pytest.raises(ResearchError):
        select(corpus(), category="test")
    with pytest.raises(ResearchError):
        select(base, unknown="test")


def test_pagination_and_ranking():
    analysis = Analysis(corpus())
    full = analysis.page()
    assert full.total == 2
    assert len(analysis.page(limit=1).items) == 1
    assert analysis.page(offset=100).items == []
    assert analysis.page(min_documents=3).total == 0
    with pytest.raises(ResearchError):
        analysis.page(limit=101)
    with pytest.raises(ResearchError):
        analysis.word("two words")


def test_text_analysis_and_reference_preprocessing():
    report = analyze_text("Cat cat! Dog?", ("cat",), reference=Analysis(corpus()))
    assert report.character_count == 13
    assert report.token_count == 3
    assert report.sentence_count_heuristic == 2
    assert report.average_word_length == 3
    assert report.vocabulary_diversity == pytest.approx(2 / 3)
    assert report.terms[0].count == 2
    assert report.terms[0].reference.groups["ai"].occurrences == 2
    assert report.dataset_version == corpus().dataset_version
    punctuation = analyze_text("!!!")
    assert punctuation.vocabulary_diversity is None
    assert punctuation.average_word_length is None
    with pytest.raises(ResearchError):
        analyze_text("  ")
    with pytest.raises(ResearchError):
        analyze_text("too long", max_chars=2)
    with pytest.raises(ResearchError):
        analyze_text("word", ("word",) * 21)
