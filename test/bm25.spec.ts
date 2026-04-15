import { describe, it, expect } from "vitest";
import { BM25Index } from "../src/search/bm25.js";

describe("BM25Index", () => {
  it("ranks more-specific documents higher", () => {
    const idx = new BM25Index();
    idx.bulk([
      { id: "a", text: "recruiting studies cancer oncology", payload: "a" },
      { id: "b", text: "enrollment diabetes", payload: "b" },
      { id: "c", text: "cancer oncology phase 3 recruiting sponsor", payload: "c" },
    ]);
    const hits = idx.search("phase 3 cancer recruiting", 3);
    expect(hits[0]?.id).toBe("c");
  });

  it("returns nothing for empty query", () => {
    const idx = new BM25Index();
    idx.add({ id: "x", text: "hello world", payload: {} });
    expect(idx.search("")).toEqual([]);
  });
});
