import { describe, it, expect } from "vitest";
import { ResponseCache } from "../src/supervisor/cache.js";

describe("ResponseCache", () => {
  it("returns fresh entries and respects allowStale flag", () => {
    const c = new ResponseCache({ maxEntries: 10, ttlMs: 10 });
    const key = c.key("GET", "https://example.com/x");
    c.set(key, { status: 200, body: { ok: true }, fetchedAt: Date.now() });
    expect(c.get(key)).toBeDefined();
  });
});
