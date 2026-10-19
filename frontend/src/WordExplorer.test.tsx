import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
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
