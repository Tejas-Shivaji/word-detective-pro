import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import "./DatasetLab.css";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const MAX_CSV_BYTES = 2_000_000;
const DEFAULT_LICENSE = "Unknown; uploader must check permitted use.";
const DEFAULT_LIMITATIONS = "User-supplied provenance and labels are unverified.";

type GroupSummary = {
  documents: number;
  total_tokens: number;
  min_tokens: number;
  median_tokens: number;
  max_tokens: number;
};

export type DatasetSummary = {
  dataset_version: string;
  analysis_version: string;
  methodology_version: string;
  rows: number;
  columns: string[];
  missing_values: number;
  duplicate_documents: number;
  conflicting_label_documents: number;
  groups: Record<string, GroupSummary>;
  metadata_counts: Record<string, Record<string, Record<string, number>>>;
  filters: Record<string, string>;
  preprocessing: { lowercase: boolean; keep_numbers: boolean; stop_words: string[] };
  provenance: { source: string; license: string; collection_version: string | null; limitations: string };
  label_definitions: Record<string, string>;
  warnings: string[];
  disclosure: string;
};

type UploadResponse = {
  dataset_token: string;
  expires_in_seconds: number;
  summary: DatasetSummary;
};

type ApiError = { error?: { message?: string } };

type DatasetLabProps = {
  datasetToken: string | null;
  setDatasetToken: (value: string | null) => void;
  datasetSummary: DatasetSummary | null;
  setDatasetSummary: (value: DatasetSummary | null) => void;
  datasetExpiresAt: number | null;
  setDatasetExpiresAt: (value: number | null) => void;
};

function errorMessage(body: ApiError, fallback: string): string {
  return body.error?.message || fallback;
}

function summaryUrl(): string {
  return `${API_BASE}/api/dataset/summary`;
}

function SummaryMetrics({ summary }: { summary: DatasetSummary }) {
  return (
    <>
      <div className="dataset-metric-grid">
        <article className="dataset-metric"><span>Accepted records</span><strong>{summary.rows.toLocaleString()}</strong><small>Rows included in analysis</small></article>
        <article className="dataset-metric"><span>Columns</span><strong>{summary.columns.length}</strong><small>Detected from the CSV header</small></article>
        <article className="dataset-metric"><span>Duplicate documents</span><strong>{summary.duplicate_documents.toLocaleString()}</strong><small>Normalized text repeats</small></article>
        <article className="dataset-metric"><span>Conflicting labels</span><strong>{summary.conflicting_label_documents.toLocaleString()}</strong><small>Repeated text with different labels</small></article>
        <article className="dataset-metric"><span>Missing values</span><strong>{summary.missing_values.toLocaleString()}</strong><small>Accepted data contains none</small></article>
        <article className="dataset-metric"><span>Method version</span><strong>{summary.methodology_version}</strong><small>Analysis method identifier</small></article>
      </div>
      <div className="dataset-group-grid">
        {(["ai", "human"] as const).map((label) => {
          const group = summary.groups[label];
          return (
            <article className="dataset-group" key={label}>
              <strong>{summary.label_definitions[label] || label}</strong>
              <span>{(group?.documents ?? 0).toLocaleString()} documents</span>
              <span>{(group?.total_tokens ?? 0).toLocaleString()} tokens</span>
              <span>Median: {(group?.median_tokens ?? 0).toFixed(1)} tokens/document</span>
            </article>
          );
        })}
      </div>
      <div className="dataset-column-list" aria-label="Dataset columns">
        {summary.columns.map((column) => <span key={column}>{column}</span>)}
      </div>
      {summary.warnings.length > 0 && (
        <>
          <h3 className="dataset-subheading">Research cautions</h3>
          <ul className="dataset-warning-list">{summary.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
        </>
      )}
      <div className="dataset-provenance">
        <h3 className="dataset-subheading">Provenance supplied with this dataset</h3>
        <p><strong>Origin:</strong> {summary.provenance.source}</p>
        <p><strong>License:</strong> {summary.provenance.license}</p>
        {summary.provenance.collection_version && <p><strong>Version:</strong> {summary.provenance.collection_version}</p>}
        <p><strong>Limitations:</strong> {summary.provenance.limitations}</p>
        <p>{summary.disclosure}</p>
      </div>
      <div className="dataset-version">DATASET SHA-256 · {summary.dataset_version.slice(0, 16)}…</div>
    </>
  );
}

function DatasetLab({
  datasetToken,
  setDatasetToken,
  datasetSummary,
  setDatasetSummary,
  datasetExpiresAt,
  setDatasetExpiresAt,
}: DatasetLabProps) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [textColumn, setTextColumn] = useState("text");
  const [labelColumn, setLabelColumn] = useState("label");
  const [aiLabel, setAiLabel] = useState("ai");
  const [humanLabel, setHumanLabel] = useState("human");
  const [sourceOrigin, setSourceOrigin] = useState("");
  const [licenseInfo, setLicenseInfo] = useState(DEFAULT_LICENSE);
  const [collectionVersion, setCollectionVersion] = useState("");
  const [limitations, setLimitations] = useState(DEFAULT_LIMITATIONS);
  const [lowercase, setLowercase] = useState(true);
  const [keepNumbers, setKeepNumbers] = useState(false);
  const [validationSummary, setValidationSummary] = useState<DatasetSummary | null>(null);
  const [validatedSignature, setValidatedSignature] = useState("");
  const [busy, setBusy] = useState<"validate" | "upload" | "refresh" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);

  const signature = useMemo(
    () => JSON.stringify([csv, textColumn, labelColumn, aiLabel, humanLabel, sourceOrigin, licenseInfo, collectionVersion, limitations, lowercase, keepNumbers]),
    [csv, textColumn, labelColumn, aiLabel, humanLabel, sourceOrigin, licenseInfo, collectionVersion, limitations, lowercase, keepNumbers],
  );
  const csvBytes = new TextEncoder().encode(csv).length;
  const validationIsCurrent = Boolean(validationSummary && validatedSignature === signature);
  const secondsDisplay = `${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`;

  useEffect(() => {
    if (!datasetToken || !datasetExpiresAt) return;
    const tick = () => {
      const remaining = Math.ceil((datasetExpiresAt - Date.now()) / 1000);
      if (remaining <= 0) {
        setDatasetToken(null);
        setDatasetSummary(null);
        setDatasetExpiresAt(null);
        setSecondsLeft(0);
        setMessage("The temporary dataset session expired. Validate and upload it again to continue.");
        return;
      }
      setSecondsLeft(remaining);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [datasetToken, datasetExpiresAt, setDatasetToken, setDatasetSummary, setDatasetExpiresAt, setMessage]);

  function buildDatasetUrl(action: "validate" | "upload"): string {
    const params = new URLSearchParams({
      source_origin: sourceOrigin.trim(),
      text_column: textColumn.trim(),
      label_column: labelColumn.trim(),
      ai_label: aiLabel.trim(),
      human_label: humanLabel.trim(),
      license_info: licenseInfo.trim(),
      limitations: limitations.trim(),
      lowercase: String(lowercase),
      keep_numbers: String(keepNumbers),
    });
    if (collectionVersion.trim()) params.set("collection_version", collectionVersion.trim());
    return `${API_BASE}/api/datasets/${action}?${params.toString()}`;
  }

  function checkInput(): string | null {
    if (!csv.trim()) return "Choose a CSV file or paste CSV text before continuing.";
    if (csvBytes > MAX_CSV_BYTES) return "CSV exceeds the 2,000,000-byte upload limit.";
    if (!sourceOrigin.trim()) return "Describe the dataset origin before validating it.";
    if (!textColumn.trim() || !labelColumn.trim()) return "Enter both the text and label column names.";
    if (!aiLabel.trim() || !humanLabel.trim() || aiLabel.trim() === humanLabel.trim()) return "AI and human label values must be different and nonblank.";
    return null;
  }

  async function validateCsv() {
    setError("");
    setMessage("");
    const invalid = checkInput();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy("validate");
    try {
      const response = await fetch(buildDatasetUrl("validate"), {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });
      const body = await response.json() as DatasetSummary & ApiError;
      if (!response.ok) throw new Error(errorMessage(body, "CSV validation failed."));
      setValidationSummary(body);
      setValidatedSignature(signature);
      setMessage(`Validation passed: ${body.rows.toLocaleString()} records and ${body.columns.length} columns accepted. The validation request did not create a dataset session.`);
    } catch (err) {
      setValidationSummary(null);
      setValidatedSignature("");
      setError(err instanceof Error ? `${err.message} Check the API connection at ${API_BASE}.` : "Unable to validate this CSV.");
    } finally {
      setBusy(null);
    }
  }

  async function uploadCsv() {
    setError("");
    setMessage("");
    const invalid = checkInput();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!validationIsCurrent) {
      setError("Validate the current CSV and configuration again before uploading.");
      return;
    }
    setBusy("upload");
    try {
      const response = await fetch(buildDatasetUrl("upload"), {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });
      const body = await response.json() as UploadResponse & ApiError;
      if (!response.ok) throw new Error(errorMessage(body, "Dataset upload failed."));
      setDatasetToken(body.dataset_token);
      setDatasetSummary(body.summary);
      setDatasetExpiresAt(Date.now() + body.expires_in_seconds * 1000);
      setSecondsLeft(body.expires_in_seconds);
      setMessage(`Dataset uploaded. The backend holds it temporarily for ${Math.floor(body.expires_in_seconds / 60)} minutes; the token is kept only in this page's React memory.`);
    } catch (err) {
      setError(err instanceof Error ? `${err.message} Check the API connection at ${API_BASE}.` : "Unable to upload this CSV.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshSummary() {
    if (!datasetToken) {
      setError("There is no active dataset token to refresh.");
      return;
    }
    setError("");
    setMessage("");
    setBusy("refresh");
    try {
      const response = await fetch(summaryUrl(), { headers: { "X-Dataset-Token": datasetToken } });
      const body = await response.json() as DatasetSummary & ApiError;
      if (!response.ok) throw new Error(errorMessage(body, "Unable to refresh the active dataset summary."));
      setDatasetSummary(body);
      setMessage("Summary refreshed from the backend using the active dataset token.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to refresh the active dataset summary.");
    } finally {
      setBusy(null);
    }
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      setError("CSV exceeds the 2,000,000-byte upload limit.");
      return;
    }
    try {
      const contents = await file.text();
      setCsv(contents);
      setFileName(file.name);
      setValidationSummary(null);
      setValidatedSignature("");
      setError("");
      setMessage("File loaded locally. Review the column mapping and validate before uploading.");
    } catch {
      setError("The selected file could not be read as text.");
    }
  }

  function forgetActiveDataset() {
    setDatasetToken(null);
    setDatasetSummary(null);
    setDatasetExpiresAt(null);
    setSecondsLeft(0);
    setMessage("The browser has forgotten the active token. Any server-side session expires automatically; this action does not delete it immediately.");
    setError("");
  }

  return (
    <section className="dataset-lab">
      <div className="page-heading-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> RESEARCH DATA / MODULE 02</div>
          <h1>Dataset Lab<span className="accent">.</span></h1>
          <p className="page-subtitle">Validate a labelled CSV, inspect the backend's real summary, then create a temporary dataset session for word comparisons.</p>
        </div>
        <div className="module-stamp"><span>02</span><small>DATA<br />LAB</small></div>
      </div>

      <div className="dataset-intro">
        <strong>Before you upload:</strong> use data you are permitted to process. The API accepts UTF-8 CSV up to 2 MB, at most 1,000 rows and 30 columns. The backend keeps uploaded datasets in bounded process memory for a short session, not in permanent storage. Labels and provenance are supplied by you and are not independently verified.
      </div>

      <div className="dataset-layout">
        <section className="panel">
          <div className="panel-header">
            <div><div className="panel-kicker">STEP 01 / INPUT</div><h2>Bring a labelled CSV</h2></div>
            <span className="step-chip">UTF-8 · CSV</span>
          </div>
          <form className="dataset-form" onSubmit={(event) => { event.preventDefault(); void validateCsv(); }}>
            <label className="dataset-field">
              <span>SELECT A CSV FILE <small>OPTIONAL IF PASTING BELOW</small></span>
              <input type="file" accept=".csv,text/csv" onChange={(event) => void loadFile(event)} />
            </label>
            <div className="dataset-file-row">
              <small>{fileName ? `Loaded locally: ${fileName}` : "No file selected"}</small>
              <small>{csvBytes.toLocaleString()} / {MAX_CSV_BYTES.toLocaleString()} bytes</small>
            </div>
            <label className="dataset-field" htmlFor="dataset-csv">
              <span>CSV CONTENT <small>REQUIRED</small></span>
              <textarea id="dataset-csv" value={csv} onChange={(event) => { setCsv(event.target.value); setFileName(""); setError(""); setMessage(""); }} placeholder={'text,label\n"An example human-written sentence.",human\n"An example AI-generated sentence.",ai'} spellCheck={false} />
            </label>
            <p className="dataset-footnote">Required columns default to <code>text</code> and <code>label</code>. Optional metadata columns named <code>category</code>, <code>source</code>, and <code>subset</code> are recognized by the backend.</p>

            <h3 className="dataset-subheading">Column and label mapping</h3>
            <div className="dataset-config-grid">
              <label className="dataset-field"><span>TEXT COLUMN</span><input value={textColumn} maxLength={100} onChange={(event) => setTextColumn(event.target.value)} required /></label>
              <label className="dataset-field"><span>LABEL COLUMN</span><input value={labelColumn} maxLength={100} onChange={(event) => setLabelColumn(event.target.value)} required /></label>
              <label className="dataset-field"><span>AI LABEL VALUE</span><input value={aiLabel} maxLength={100} onChange={(event) => setAiLabel(event.target.value)} required /></label>
              <label className="dataset-field"><span>HUMAN LABEL VALUE</span><input value={humanLabel} maxLength={100} onChange={(event) => setHumanLabel(event.target.value)} required /></label>
            </div>

            <h3 className="dataset-subheading">Source and responsible use</h3>
            <label className="dataset-field"><span>DATASET ORIGIN <small>REQUIRED</small></span><input value={sourceOrigin} maxLength={500} onChange={(event) => setSourceOrigin(event.target.value)} placeholder="Where did this dataset come from?" required /></label>
            <label className="dataset-field"><span>LICENSE / PERMITTED USE</span><input value={licenseInfo} maxLength={500} onChange={(event) => setLicenseInfo(event.target.value)} required /></label>
            <label className="dataset-field"><span>COLLECTION VERSION <small>OPTIONAL</small></span><input value={collectionVersion} maxLength={200} onChange={(event) => setCollectionVersion(event.target.value)} placeholder="e.g. v1.0 or collection date" /></label>
            <label className="dataset-field"><span>KNOWN LIMITATIONS</span><textarea value={limitations} maxLength={1000} onChange={(event) => setLimitations(event.target.value)} rows={2} required /></label>
            <div className="dataset-options">
              <label><input type="checkbox" checked={lowercase} onChange={(event) => setLowercase(event.target.checked)} /> Lowercase tokens</label>
              <label><input type="checkbox" checked={keepNumbers} onChange={(event) => setKeepNumbers(event.target.checked)} /> Keep numbers</label>
            </div>
            <div className="dataset-actions">
              <button className="primary-button" type="submit" disabled={busy !== null}>{busy === "validate" ? <><span className="spinner" /> Validating...</> : <>Validate CSV <span>→</span></>}</button>
              <button className="secondary-button" type="button" onClick={() => void uploadCsv()} disabled={busy !== null || !validationIsCurrent}>{busy === "upload" ? "Uploading..." : "Upload validated CSV"}</button>
            </div>
            <p className="dataset-footnote">Validation parses the file without creating a session. Upload parses it again and creates a temporary session token. Editing any input requires re-validation.</p>
            {error && <div className="dataset-error" role="alert">{error}</div>}
            {message && <div className="dataset-status" role="status">{message}</div>}
          </form>
        </section>

        <div className="dataset-side">
          <section className="panel">
            <div className="panel-header">
              <div><div className="panel-kicker">STEP 02 / VALIDATION</div><h2>Validation result</h2></div>
              <span className={validationIsCurrent ? "result-state complete" : "result-state"}><span className="status-dot" />{validationIsCurrent ? "VALIDATED" : "NOT CURRENT"}</span>
            </div>
            {validationSummary ? (
              <div className="dataset-summary-body">
                {!validationIsCurrent && <p className="dataset-footnote">The displayed result is from a previous configuration. Validate again before uploading.</p>}
                <SummaryMetrics summary={validationSummary} />
              </div>
            ) : (
              <div className="dataset-empty"><span className="empty-symbol">▤</span><h3>No validation yet</h3><p>Provide the CSV and its mapping. The API will return the accepted row count, label balance, duplicate checks, and research cautions.</p></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <div><div className="panel-kicker">STEP 03 / ACTIVE SESSION</div><h2>Uploaded dataset</h2></div>
              <span className={datasetToken ? "result-state complete" : "result-state"}><span className="status-dot" />{datasetToken ? "ACTIVE" : "NONE"}</span>
            </div>
            {datasetToken && datasetSummary ? (
              <>
                <div className="dataset-token-row"><div><span>SESSION TOKEN HELD IN MEMORY</span><br /><small>Expires in about {secondsDisplay}</small></div><button className="secondary-button" type="button" onClick={() => void refreshSummary()} disabled={busy !== null}>{busy === "refresh" ? "Refreshing..." : "Refresh summary"}</button></div>
                <div className="dataset-summary-body"><SummaryMetrics summary={datasetSummary} /></div>
                <div className="dataset-token-row"><small>The token enables the Text Analysis reference and Word Explorer API. It is not written to localStorage or sessionStorage.</small><button className="secondary-button" type="button" onClick={forgetActiveDataset}>Forget token</button></div>
              </>
            ) : (
              <div className="dataset-empty"><span className="empty-symbol">◈</span><h3>No active dataset</h3><p>After validation, upload the CSV to receive an ephemeral token. You can then use the dataset as a reference in other research modules.</p></div>
            )}
          </section>
        </div>
      </div>
      <footer className="page-footer"><span>WORD DETECTIVE PRO <span className="footer-separator">/</span> DATASET LAB</span><span>Validate first. Interpret cautiously.</span></footer>
    </section>
  );
}

export default DatasetLab;
