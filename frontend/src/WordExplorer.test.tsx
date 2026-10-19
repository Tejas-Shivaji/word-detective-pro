import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WordExplorer from "./WordExplorer";

function page(word: string, offset = 0) {
  return {
    dataset_version: "test-dataset",
    analysis_version: "test-analysis",
    filters: {},
    total: 1,
    offset,
    limit: 25,
    items: [
      {
        word,
        groups: {},
        difference_per_1000: null,
        absolute_difference_per_1000: null,
        frequency_ratio_ai_over_human: null,
        ratio_method: "test",
        difference_interval: null,
        p_value: null,
        q_value: null,
        tested_words: 1,
        test: "test",
        uncertainty_note: "Test fixture only",
      },
    ],
    disclosure: "Test fixture only",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WordExplorer request ordering", () => {
  it("does not let an older response replace the latest vocabulary page", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/minimum occurrences/i), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(jsonResponse(page("newest-word")));
      await second.promise;
    });

    expect(await screen.findByText("newest-word")).toBeInTheDocument();

    await act(async () => {
      first.resolve(jsonResponse(page("older-word")));
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("newest-word")).toBeInTheDocument();
      expect(screen.queryByText("older-word")).not.toBeInTheDocument();
    });
  });
});

describe("WordExplorer controls", () => {
  it("applies support thresholds and resets the page offset", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ...page("first-word"), total: 100 }))
      .mockResolvedValueOnce(jsonResponse({ ...page("filtered-word"), total: 1 }));

    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText(/minimum occurrences/i), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/minimum documents/i), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const requestedUrl = String(fetchMock.mock.calls[1][0]);
    const params = new URL(requestedUrl).searchParams;

    expect(params.get("offset")).toBe("0");
    expect(params.get("min_count")).toBe("3");
    expect(params.get("min_documents")).toBe("2");
    expect(await screen.findByText("filtered-word")).toBeInTheDocument();
  });

  it("requests the next page with the correct offset", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ ...page("first-page-word"), total: 50 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...page("second-page-word", 25),
          total: 50,
          offset: 25,
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /next/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const requestedUrl = String(fetchMock.mock.calls[1][0]);
    const params = new URL(requestedUrl).searchParams;

    expect(params.get("offset")).toBe("25");
    expect(params.get("limit")).toBe("25");
    expect(await screen.findByText("second-page-word")).toBeInTheDocument();
  });
});

describe("WordExplorer API states", () => {
  it("shows the API error message when vocabulary loading fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: { message: "Service unavailable" },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Service unavailable",
    );

    expect(
      screen.getByText(/no word list available/i),
    ).toBeInTheDocument();
  });

  it("shows an empty state when the API returns no matching words", async () => {
    const emptyPage = {
      ...page("unused-word"),
      total: 0,
      items: [],
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emptyPage));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    expect(
      await screen.findByText("No words meet these support thresholds."),
    ).toBeInTheDocument();

    expect(screen.getByText(/showing 0–0 of 0/i)).toBeInTheDocument();
  });
});

describe("WordExplorer word report API", () => {
  it("sends the dataset token and displays an API error when a word report fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page("word with space")))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          error: { message: "Report service unavailable" },
        }),
      } as Response);

    vi.stubGlobal("fetch", fetchMock);

    render(
      <WordExplorer
        datasetToken="test-token"
        onOpenDatasetLab={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /inspect/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Report service unavailable",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [requestedUrl, options] = fetchMock.mock.calls[1];

    expect(String(requestedUrl)).toContain(
      "/api/words/word%20with%20space?resamples=500",
    );
    expect(options.headers).toEqual({
      "X-Dataset-Token": "test-token",
    });
  });
});
