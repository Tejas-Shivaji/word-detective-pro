import { useEffect, useState } from "react";
import "./App.css";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

type Health = {
  status: string;
  version: string;
  storage: string;
  dataset_configured: boolean;
};

type TermResult = {
  word: string;
  count: number;
  per_1000_tokens: number | null;
  reference: {
    difference_per_1000: number | null;
    p_value: number | null;
    q_value: number | null;
    groups: Record<string, { occurrences: number; per_1000_tokens: number | null }>;
  } | null;
};

type TextReport = {
  character_count: number;
  token_count: number;
  sentence_count_heuristic: number;
  average_word_length: number | null;
  vocabulary_diversity: number | null;
  definitions: string;
  terms: TermResult[];
  dataset_version: string | null;
  analysis_version: string | null;
  disclosure: string;
};

type ApiError = { error?: { message?: string } };

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [text, setText] = useState("");
  const [terms, setTerms] = useState("");
  const [report, setReport] = useState<TextReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activePage, setActivePage] = useState("Text Analysis");

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const response = await fetch(`${API_BASE}/api/health`);
        if (!response.ok) throw new Error("The API returned an unsuccessful response.");
        const data: Health = await response.json();
        if (!cancelled) {
          setHealth(data);
          setHealthError("");
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setHealthError("Backend unavailable");
        }
      }
    }

    void checkHealth();
    const interval = window.setInterval(() => void checkHealth(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function analyzeText(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setReport(null);

    if (!text.trim()) {
      setError("Enter some text before starting the analysis.");
      return;
    }

    const selectedTerms = [...new Set(
      terms.split(",").map((term) => term.trim()).filter(Boolean),
    )];

    if (selectedTerms.length > 20) {
      setError("Select no more than 20 terms.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/analyze-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, terms: selectedTerms }),
      });

      const data: TextReport & ApiError = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || "Analysis failed. Please try again.");
      }
      setReport(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} Check that the backend is running at ${API_BASE}.`
          : "Unable to complete the analysis.",
      );
    } finally {
      setLoading(false);
    }
  }

  const metrics = report
    ? [
        { label: "Characters", value: report.character_count.toLocaleString(), note: "Unicode code points" },
        { label: "Analysis tokens", value: report.token_count.toLocaleString(), note: "After preprocessing" },
        { label: "Sentence estimate", value: report.sentence_count_heuristic.toLocaleString(), note: "Punctuation heuristic" },
        { label: "Average word length", value: report.average_word_length?.toFixed(2) ?? "—", note: "Characters per token" },
        { label: "Vocabulary diversity", value: report.vocabulary_diversity == null ? "—" : `${(report.vocabulary_diversity * 100).toFixed(1)}%`, note: "Unique tokens / all tokens" },
      ]
    : [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setActivePage("Text Analysis")}>
          <span className="brand-mark">W<span>.</span></span>
          <span>
            <strong>Word Detective</strong>
            <small>RESEARCH STUDIO</small>
          </span>
        </a>

        <div className="nav-caption">WORKSPACE</div>
        <button className={`nav-item ${activePage === "Overview" ? "active" : ""}`} onClick={() => setActivePage("Overview")}>
          <span className="nav-icon">◫</span> Overview
        </button>
        <button className={`nav-item ${activePage === "Text Analysis" ? "active" : ""}`} onClick={() => setActivePage("Text Analysis")}>
          <span className="nav-icon">⌕</span> Text Analysis
          <span className="nav-badge">01</span>
        </button>
        <button className={`nav-item ${activePage === "Dataset Lab" ? "active" : ""}`} onClick={() => setActivePage("Dataset Lab")}>
          <span className="nav-icon">▤</span> Dataset Lab
          <span className="soon-label">NEXT</span>
        </button>
        <button className={`nav-item ${activePage === "Word Explorer" ? "active" : ""}`} onClick={() => setActivePage("Word Explorer")}>
          <span className="nav-icon">⌘</span> Word Explorer
          <span className="soon-label">NEXT</span>
        </button>

        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span className="privacy-icon">◈</span>
            <strong>Research, not verdicts.</strong>
            <p>Patterns are evidence to explore, not proof of who wrote a text.</p>
          </div>
          <div className="sidebar-footer">
            <span className={`status-dot ${health ? "online" : ""}`} />
            <span>{health ? "API connected" : "API disconnected"}</span>
            <span className="version-label">v0.1.0</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>{activePage}</strong></div>
          <div className="topbar-right">
            <span className={`connection-pill ${health ? "connected" : "disconnected"}`}>
              <span className="status-dot" />
              {health ? "System online" : "System offline"}
            </span>
            <div className="avatar">WD</div>
          </div>
        </header>

        {activePage === "Overview" ? (
          <section className="page-content">
            <div className="eyebrow">YOUR WORKSPACE</div>
            <h1>Research overview<span className="accent">.</span></h1>
            <p className="page-subtitle">A workspace for exploring language patterns with transparent methods.</p>
            <div className="overview-grid">
              <article className="overview-card">
                <span className="card-icon">⌕</span>
                <h3>Text Analysis</h3>
                <p>Inspect text length, token counts, vocabulary diversity, and selected terms.</p>
                <button className="text-link" onClick={() => setActivePage("Text Analysis")}>Open analysis ↗</button>
              </article>
              <article className="overview-card">
                <span className="card-icon">▤</span>
                <h3>Dataset Lab</h3>
                <p>Next milestone: validate a CSV and upload a temporary research dataset.</p>
                <span className="muted-label">IN DEVELOPMENT</span>
              </article>
              <article className="overview-card">
                <span className="card-icon">⌘</span>
                <h3>Word Explorer</h3>
                <p>Next milestone: explore word frequency and document prevalence by group.</p>
                <span className="muted-label">IN DEVELOPMENT</span>
              </article>
            </div>
          </section>
        ) : activePage !== "Text Analysis" ? (
          <section className="page-content">
            <div className="eyebrow">COMING NEXT</div>
            <h1>{activePage}<span className="accent">.</span></h1>
            <p className="page-subtitle">This module is planned, but it is not implemented yet.</p>
            <article className="empty-module">
              <span className="empty-symbol">⌘</span>
              <h2>Building this research module</h2>
              <p>We're developing the core workflow before enabling this section. No placeholder statistics will be shown.</p>
              <button className="primary-button" onClick={() => setActivePage("Text Analysis")}>Return to Text Analysis <span>→</span></button>
            </article>
          </section>
        ) : (
          <section className="page-content">
            <div className="page-heading-row">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> LANGUAGE RESEARCH / MODULE 01</div>
                <h1>Text Analysis<span className="accent">.</span></h1>
                <p className="page-subtitle">Explore the measurable features of a text. Start with the words, not assumptions.</p>
              </div>
              <div className="module-stamp"><span>01</span><small>TEXT<br />LAB</small></div>
            </div>

            <div className="notice-banner">
              <span className="notice-icon">ⓘ</span>
              <div><strong>Interpret with care</strong><p>These metrics describe text. They do not establish whether a human or AI wrote it.</p></div>
            </div>

            <div className="analysis-layout">
              <section className="panel input-panel">
                <div className="panel-header">
                  <div><div className="panel-kicker">INPUT</div><h2>Bring your text</h2></div>
                  <span className="step-chip">STEP 01</span>
                </div>
                <form onSubmit={analyzeText}>
                  <label className="field-label" htmlFor="research-text">TEXT SAMPLE <span>REQUIRED</span></label>
                  <textarea
                    id="research-text"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    maxLength={20000}
                    placeholder="Paste a paragraph, essay, or writing sample here..."
                    rows={10}
                  />
                  <div className="textarea-meta"><span>{text.length.toLocaleString()} / 20,000 characters</span><span>{text.trim() ? "Ready to analyze" : "Awaiting input"}</span></div>

                  <label className="field-label term-label" htmlFor="research-terms">TERMS TO INSPECT <span>OPTIONAL · UP TO 20</span></label>
                  <input id="research-terms" value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="e.g. however, therefore, imagine" />
                  <p className="field-help">Separate terms with commas. Each term must match one token under the selected preprocessing rules.</p>

                  {error && <div className="error-message" role="alert"><span>!</span><p>{error}</p></div>}

                  <button className="primary-button analyze-button" type="submit" disabled={loading}>
                    {loading ? <><span className="spinner" /> Analyzing text...</> : <>Analyze text <span>→</span></>}
                  </button>
                  <div className="form-footnote"><span>◈</span> Results are computed by your connected research API.</div>
                </form>
              </section>

              <section className="results-column">
                <div className="panel results-panel">
                  <div className="panel-header">
                    <div><div className="panel-kicker">OUTPUT</div><h2>Analysis results</h2></div>
                    <span className={`result-state ${report ? "complete" : ""}`}><span className="status-dot" />{report ? "COMPLETE" : "AWAITING INPUT"}</span>
                  </div>

                  {!report ? (
                    <div className="results-empty">
                      <div className="empty-illustration"><span className="illustration-ring" /><span className="illustration-glyph">W<span>.</span></span></div>
                      <h3>Your findings start here.</h3>
                      <p>Submit a text sample to calculate its metrics. Results will appear here when the API responds.</p>
                      <div className="empty-checklist"><span>01</span> Submit a text sample <span className="check-divider">/</span> <span>02</span> Review the measurements</div>
                    </div>
                  ) : (
                    <div className="metric-grid">
                      {metrics.map((metric) => (
                        <article className="metric-card" key={metric.label}>
                          <span>{metric.label}</span>
                          <strong>{metric.value}</strong>
                          <small>{metric.note}</small>
                        </article>
                      ))}
                    </div>
                  )}
                </div>

                {report && (
                  <>
                    <div className="panel terms-panel">
                      <div className="panel-header">
                        <div><div className="panel-kicker">WORD BREAKDOWN</div><h2>Selected terms</h2></div>
                        <span className="step-chip">{report.terms.length} TERMS</span>
                      </div>
                      {report.terms.length === 0 ? (
                        <p className="no-terms">No terms were selected. Add comma-separated terms above and analyze again to inspect them.</p>
                      ) : (
                        <div className="table-scroll">
                          <table>
                            <thead><tr><th>TERM</th><th>COUNT</th><th>PER 1,000 TOKENS</th><th>REFERENCE</th></tr></thead>
                            <tbody>{report.terms.map((term) => (
                              <tr key={term.word}>
                                <td className="word-cell">{term.word}</td>
                                <td>{term.count}</td>
                                <td>{term.per_1000_tokens?.toFixed(2) ?? "—"}</td>
                                <td>{term.reference ? (term.reference.difference_per_1000 == null ? "Unavailable" : term.reference.difference_per_1000.toFixed(2)) : "Not connected"}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                          <p className="field-help">Reference comparisons require a selected dataset. A blank reference is not evidence of similarity or difference.</p>
                        </div>
                      )}
                    </div>
                    <div className="method-note"><strong>Method note</strong><p>{report.definitions}</p><p>{report.disclosure}</p></div>
                  </>
                )}
              </section>
            </div>

            {healthError && <div className="backend-warning"><span>!</span><div><strong>Backend connection needed</strong><p>{healthError}. Start the FastAPI service and enable the frontend origin in its CORS configuration.</p><code>{API_BASE}</code></div></div>}
          </section>
        )}
        <footer className="page-footer"><span>WORD DETECTIVE PRO <span className="footer-separator">/</span> RESEARCH BUILD</span><span>Explainable patterns. Responsible interpretation.</span></footer>
      </main>
    </div>
  );
}

export default App;
