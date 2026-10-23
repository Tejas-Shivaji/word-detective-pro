import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DatasetLab, { type DatasetSummary } from "./DatasetLab";

const csv = [
  "text,label,source_origin",
  '"A human example.",human,test',
  '"An AI example.",ai,test',
].join("\n");

function makeSummary(): DatasetSummary {
  const group = {
    documents: 1,
    total_tokens: 3,
    min_tokens: 3,
    median_tokens: 3,
    max_tokens: 3,
  };

  return {
    dataset_version: "test-dataset-v1",
    analysis_version: "test-analysis-v1",
    methodology_version: "test-method-v1",
    rows: 12,
    columns: ["text", "label", "source_origin"],
    missing_values: 0,
    duplicate_documents: 0,
    conflicting_label_documents: 0,
    groups: { ai: group, human: group },
    metadata_counts: {},
    filters: {},
    preprocessing: {
      lowercase: true,
      keep_numbers: false,
      stop_words: [],
    },
    provenance: {
      source: "Test dataset",
      license: "Permitted for testing",
      collection_version: null,
      limitations: "Synthetic test data",
    },
    label_definitions: { ai: "AI-generated", human: "Human-written" },
    warnings: [],
    disclosure: "Test summary",
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function renderDatasetLab() {
  return render(
    <DatasetLab
      datasetToken={null}
      setDatasetToken={vi.fn()}
      datasetSummary={null}
      setDatasetSummary={vi.fn()}
      datasetExpiresAt={null}
      setDatasetExpiresAt={vi.fn()}
    />,
  );
}

function enterCsv() {
  fireEvent.change(screen.getByPlaceholderText(/An example human-written sentence/), {
    target: { value: csv },
  });
  fireEvent.change(screen.getByPlaceholderText("Where did this dataset come from?"), {
    target: { value: "Synthetic test dataset" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DatasetLab", () => {
  it("requires CSV content and dataset origin before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderDatasetLab();
    fireEvent.change(screen.getByPlaceholderText("Where did this dataset come from?"), { target: { value: "Synthetic test dataset" } });
    fireEvent.click(screen.getByRole("button", { name: /validate csv/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a CSV file or paste CSV text before continuing.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the raw CSV with text/csv and displays successful validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeSummary()));
    vi.stubGlobal("fetch", fetchMock);

    renderDatasetLab();
    enterCsv();
    fireEvent.click(screen.getByRole("button", { name: /validate csv/i }));

    expect(
      await screen.findByRole("status"),
    ).toHaveTextContent("Validation passed: 12 records and 3 columns accepted.");

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toContain("/api/datasets/validate?");
    expect(url).toContain("text_column=text");
    expect(url).toContain("label_column=label");
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "text/csv" });
    expect(options.body).toBe(csv);

    expect(
      screen.getByRole("button", { name: /upload validated csv/i }),
    ).toBeEnabled();
  });

  it("shows the API validation error and does not enable upload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "missing_columns",
            message: "The configured text and label columns must exist.",
          },
        },
        false,
        422,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderDatasetLab();
    enterCsv();
    fireEvent.click(screen.getByRole("button", { name: /validate csv/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The configured text and label columns must exist.",
    );
    expect(
      screen.getByRole("button", { name: /upload validated csv/i }),
    ).toBeDisabled();
  });

  it("uploads only after validation and stores the temporary session", async () => {
    const summary = makeSummary();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(summary))
      .mockResolvedValueOnce(
        jsonResponse({
          dataset_token: "test-session-token",
          expires_in_seconds: 600,
          summary,
        }),
      );

    const setDatasetToken = vi.fn();
    const setDatasetSummary = vi.fn();
    const setDatasetExpiresAt = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    render(
      <DatasetLab
        datasetToken={null}
        setDatasetToken={setDatasetToken}
        datasetSummary={null}
        setDatasetSummary={setDatasetSummary}
        datasetExpiresAt={null}
        setDatasetExpiresAt={setDatasetExpiresAt}
      />,
    );

    enterCsv();

    const uploadButton = screen.getByRole("button", {
      name: /upload validated csv/i,
    });
    expect(uploadButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /validate csv/i }));

    await screen.findByText(/Validation passed: 12 records/);
    await waitFor(() => expect(uploadButton).toBeEnabled());

    fireEvent.click(uploadButton);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Dataset uploaded.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadOptions] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];

    expect(uploadUrl).toContain("/api/datasets/upload?");
    expect(uploadOptions.method).toBe("POST");
    expect(uploadOptions.headers).toEqual({ "Content-Type": "text/csv" });
    expect(uploadOptions.body).toBe(csv);

    expect(setDatasetToken).toHaveBeenCalledWith("test-session-token");
    expect(setDatasetSummary).toHaveBeenCalledWith(summary);
    expect(setDatasetExpiresAt).toHaveBeenCalledWith(expect.any(Number));
  });
});
