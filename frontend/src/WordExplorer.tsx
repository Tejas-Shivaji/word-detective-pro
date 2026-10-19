import { useCallback, useEffect, useMemo, useState } from "react";
import "./WordExplorer.css";

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
).replace(/\/$/, "");

type Props = {
  datasetToken: string | null;
  onOpenDatasetLab: () => void;
};

type Interval = {
  lower: number;
  upper: number;
  confidence?: number;
  method: string;
};

type GroupWord = {
  occurrences: number;
  documents_containing: number;
  documents: number;
  total_tokens: number;
  token_probability: number | null;
  per_1000_tokens: number | null;
  document_prevalence: number | null;
  prevalence_interval: Interval | null;
  frequency_interval: Interval | null;
};

type WordResult = {
  word: string;
  groups: Record<string, GroupWord>;
  difference_per_1000: number | null;
  absolute_difference_per_1000: number | null;
  frequency_ratio_ai_over_human: number | null;
  ratio_method: string;
  difference_interval: Interval | null;
  p_value: number | null;
  q_value: number | null;
  tested_words: number;
  test: string;
  uncertainty_note: string;
};

type WordPage = {
  dataset_version: string;
  analysis_version: string;
  filters: Record<string, string>;
  total: number;
  offset: number;
  limit: number;
  items: WordResult[];
  disclosure: string;
};

type WordReport = {
  dataset_version: string;
  analysis_version: string;
  filters: Record<string, string>;
  preprocessing: {
    lowercase: boolean;
    keep_numbers: boolean;
    stop_words: string[];
  };
  result: WordResult;
  disclosure: string;
};

type ApiError = {
  error?: {
    code?: string;
    message?: string;
  };
};

const PAGE_SIZE = 25;

function formatNumber(value: number | null | undefined, digits = 3): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, {
        maximumFractionDigits: digits,
      });
}

function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(2)}%`;
}

function formatInterval(interval: Interval | null | undefined): string {
  if (!interval) return "Not available";
  return `${formatNumber(interval.lower)} to ${formatNumber(interval.upper)}`;
}

function groupFor(result: WordResult, name: "ai" | "human"): GroupWord | undefined {
  return result.groups[name];
}

async function readError(response: Response): Promise<string> {
  try {
    const body: ApiError = await response.json();
    return body.error?.message || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export default function WordExplorer({
  datasetToken,
  onOpenDatasetLab,
}: Props) {
  const [data, setData] = useState<WordPage | null>(null);
  const [selected, setSelected] = useState<WordReport | null>(null);
  const [detailWord, setDetailWord] = useState("");
  const [search, setSearch] = useState("");
  const [minCount, setMinCount] = useState(1);
  const [minDocuments, setMinDocuments] = useState(1);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");

  const loadWords = useCallback(async () => {
    if (!datasetToken) {
      setData(null);
      setSelected(null);
      setDetailWord("");
      setError("");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE_SIZE),
      min_count: String(minCount),
      min_documents: String(minDocuments),
    });

    try {
      const response = await fetch(`${API_BASE}/api/words?${params}`, {
        headers: { "X-Dataset-Token": datasetToken },
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const page: WordPage = await response.json();
      setData(page);
    } catch (err) {
      setData(null);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load vocabulary from the API.",
      );
    } finally {
      setLoading(false);
    }
  }, [datasetToken, offset, minCount, minDocuments]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadWords();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadWords]);

  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!data) return [];
    if (!query) return data.items;
    return data.items.filter((item) =>
      item.word.toLocaleLowerCase().includes(query),
    );
  }, [data, search]);

  async function openWord(word: string) {
    if (!datasetToken) {
      setDetailError("Upload a dataset in Dataset Lab before inspecting words.");
      return;
    }

    setDetailWord(word);
    setSelected(null);
    setDetailError("");
    setDetailLoading(true);

    try {
      const response = await fetch(
        `${API_BASE}/api/words/${encodeURIComponent(word)}?resamples=500`,
        { headers: { "X-Dataset-Token": datasetToken } },
      );

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const report: WordReport = await response.json();
      setSelected(report);
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Unable to load the word report.",
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function applyThresholds() {
    setOffset(0);
    setSelected(null);
    setDetailWord("");
    void loadWords();
  }

  const activeError = /expired|unknown|session/i.test(error);

  return (
    <section className="wx-page">
      <div className="page-heading-row">
        <div>
          <div className="eyebrow">RESEARCH TOOLS / VOCABULARY</div>
          <h1>
            Word Explorer<span className="accent">.</span>
          </h1>
          <p className="page-subtitle">
            Compare word frequency and document prevalence across AI-labelled
            and human-labelled documents.
          </p>
        </div>

        <div className="wx-version">
          <span>{datasetToken ? "ACTIVE DATASET" : "NO ACTIVE DATASET"}</span>
          <strong>
            {datasetToken && data ? data.total.toLocaleString() : "—"} words
          </strong>
        </div>
      </div>

      {!datasetToken && (
        <div className="wx-notice">
          <strong>No active dataset</strong>
          <p>
            Word Explorer needs a dataset uploaded through Dataset Lab. Upload
            and validate a labelled CSV, then return here to explore its
            vocabulary. Dataset sessions are temporary.
          </p>
          <button
            className="wx-refresh wx-open-lab"
            onClick={onOpenDatasetLab}
          >
            Open Dataset Lab →
          </button>
        </div>
      )}

      {datasetToken && (
        <section className="panel wx-controls">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">VOCABULARY SETTINGS</div>
              <h2>Explore the word list</h2>
            </div>
            <button
              className="wx-refresh"
              onClick={() => void loadWords()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Refresh results"}
            </button>
          </div>

          <div className="wx-control-grid">
            <label>
              <span>SEARCH THIS PAGE</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a word…"
              />
            </label>

            <label>
              <span>MINIMUM OCCURRENCES</span>
              <input
                type="number"
                min={1}
                step={1}
                value={minCount}
                onChange={(event) =>
                  setMinCount(Math.max(1, Number(event.target.value) || 1))
                }
              />
            </label>

            <label>
              <span>MINIMUM DOCUMENTS</span>
              <input
                type="number"
                min={1}
                step={1}
                value={minDocuments}
                onChange={(event) =>
                  setMinDocuments(
                    Math.max(1, Number(event.target.value) || 1),
                  )
                }
              />
            </label>

            <button
              className="wx-refresh"
              onClick={applyThresholds}
              disabled={loading}
            >
              Apply filters
            </button>
          </div>

          <p className="field-help">
            Search filters the currently loaded page. Support thresholds are
            applied by the API to the selected dataset.
          </p>
        </section>
      )}

      {error && (
        <div className="error-message" role="alert">
          <span>!</span>
          <div>
            <p>{error}</p>
            {activeError && (
              <button className="wx-detail-link" onClick={onOpenDatasetLab}>
                Open Dataset Lab to upload again
              </button>
            )}
          </div>
        </div>
      )}

      {datasetToken && (
        <section className="panel wx-table-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">OBSERVED VOCABULARY</div>
              <h2>Word frequency comparison</h2>
            </div>
            {data && (
              <span className="result-count">
                {data.total.toLocaleString()} matching words
              </span>
            )}
          </div>

          {loading ? (
            <div className="wx-state">Loading vocabulary from the API…</div>
          ) : !data ? (
            <div className="wx-state">
              No word list available. Refresh the results or check whether
              your dataset session has expired.
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="wx-state">
              {data.items.length === 0
                ? "No words meet these support thresholds."
                : "No words on this page match your search."}
            </div>
          ) : (
            <div className="table-scroll wx-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Word</th>
                    <th>AI / 1,000 tokens</th>
                    <th>Human / 1,000 tokens</th>
                    <th>Difference</th>
                    <th>AI / Human ratio</th>
                    <th>Adjusted q-value</th>
                    <th>Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={item.word}>
                      <td><strong>{item.word}</strong></td>
                      <td>{formatNumber(groupFor(item, "ai")?.per_1000_tokens)}</td>
                      <td>{formatNumber(groupFor(item, "human")?.per_1000_tokens)}</td>
                      <td>{formatNumber(item.difference_per_1000)}</td>
                      <td>{formatNumber(item.frequency_ratio_ai_over_human)}</td>
                      <td>{formatNumber(item.q_value, 5)}</td>
                      <td>
                        <button
                          className="wx-detail-link"
                          onClick={() => void openWord(item.word)}
                        >
                          Inspect →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data && (
            <div className="wx-pagination">
              <span>
                Showing {data.total === 0 ? 0 : data.offset + 1}–
                {Math.min(data.offset + data.items.length, data.total)} of{" "}
                {data.total.toLocaleString()}
              </span>
              <div>
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  ← Previous
                </button>
                <button
                  disabled={loading || offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
          {data && <p className="field-help">{data.disclosure}</p>}
        </section>
      )}

      {datasetToken && detailWord && (
        <section className="panel wx-detail-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">WORD REPORT</div>
              <h2>{detailWord}</h2>
            </div>
            <button
              className="wx-detail-link"
              onClick={() => {
                setDetailWord("");
                setSelected(null);
                setDetailError("");
              }}
            >
              Close
            </button>
          </div>

          {detailLoading && (
            <div className="wx-state">Calculating the word report…</div>
          )}

          {detailError && (
            <div className="error-message" role="alert">
              <span>!</span>
              <p>{detailError}</p>
            </div>
          )}

          {selected && (
            <>
              <div className="wx-groups">
                {(["ai", "human"] as const).map((label) => {
                  const group = groupFor(selected.result, label);
                  return (
                    <article className="wx-group" key={label}>
                      <h3>{label === "ai" ? "AI-labelled documents" : "Human-labelled documents"}</h3>
                      <div className="wx-stat-grid">
                        <Metric label="Occurrences" value={group?.occurrences.toLocaleString() ?? "—"} />
                        <Metric label="Documents containing word" value={group?.documents_containing.toLocaleString() ?? "—"} />
                        <Metric label="Documents in group" value={group?.documents.toLocaleString() ?? "—"} />
                        <Metric label="Total tokens" value={group?.total_tokens.toLocaleString() ?? "—"} />
                        <Metric label="Occurrences / 1,000 tokens" value={formatNumber(group?.per_1000_tokens)} />
                        <Metric label="Document prevalence" value={formatPercent(group?.document_prevalence)} />
                      </div>
                      <div className="wx-interval">
                        <span>Frequency interval</span>
                        <strong>{formatInterval(group?.frequency_interval)}</strong>
                      </div>
                      <div className="wx-interval">
                        <span>Prevalence interval</span>
                        <strong>{formatInterval(group?.prevalence_interval)}</strong>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="wx-stat-grid wx-inference-grid">
                <Metric
                  label="AI − Human difference / 1,000 tokens"
                  value={formatNumber(selected.result.difference_per_1000)}
                />
                <Metric
                  label="95% difference interval"
                  value={formatInterval(selected.result.difference_interval)}
                />
                <Metric
                  label="AI / Human frequency ratio"
                  value={formatNumber(selected.result.frequency_ratio_ai_over_human)}
                />
                <Metric label="p-value" value={formatNumber(selected.result.p_value, 6)} />
                <Metric label="Adjusted q-value" value={formatNumber(selected.result.q_value, 6)} />
                <Metric label="Words tested" value={selected.result.tested_words.toLocaleString()} />
              </div>

              <div className="wx-method">
                <h3>Method and uncertainty</h3>
                <p>{selected.result.uncertainty_note}</p>
                <p>{selected.result.test}</p>
                <p>{selected.result.ratio_method}</p>
                <p>{selected.disclosure}</p>
              </div>
            </>
          )}
        </section>
      )}
    </section>
  );
}
