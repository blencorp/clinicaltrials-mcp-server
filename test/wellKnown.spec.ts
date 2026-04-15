import { describe, it, expect } from "vitest";
import {
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  makeASMetadataFetcher,
} from "../src/server/wellKnown.js";
import type { AuthConfig } from "../src/auth/config.js";

const base: AuthConfig = {
  provider: "clerk",
  resource: "https://clinicaltrial.mcp.blencorp.com/mcp",
  issuer: "https://clerk.blencorp.com",
  scopesSupported: ["ctgov.read"],
};

describe("protectedResourceMetadata (RFC 9728)", () => {
  it("emits required fields", () => {
    const doc = protectedResourceMetadata(base);
    expect(doc.resource).toBe("https://clinicaltrial.mcp.blencorp.com/mcp");
    expect(doc.authorization_servers).toEqual(["https://clerk.blencorp.com"]);
    expect(doc.bearer_methods_supported).toContain("header");
    expect(doc.scopes_supported).toEqual(["ctgov.read"]);
  });
});

describe("wwwAuthenticateHeader", () => {
  it("includes resource_metadata pointing at the well-known URL", () => {
    const h = wwwAuthenticateHeader(base);
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`realm="https://clinicaltrial.mcp.blencorp.com/mcp"`);
    expect(h).toContain(
      `resource_metadata="https://clinicaltrial.mcp.blencorp.com/.well-known/oauth-protected-resource"`,
    );
  });
});

describe("makeASMetadataFetcher", () => {
  it("returns null when issuer is blank", async () => {
    const f = makeASMetadataFetcher({ ...base, issuer: "" });
    expect(await f.get()).toBeNull();
  });

  it("caches successful responses", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ issuer: "https://clerk.blencorp.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const f = makeASMetadataFetcher(base, fakeFetch);
    const a = await f.get();
    const b = await f.get();
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("caches negative responses", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response("nope", { status: 500 });
    };
    const f = makeASMetadataFetcher(base, fakeFetch);
    expect(await f.get()).toBeNull();
    expect(await f.get()).toBeNull();
    expect(calls).toBe(1);
  });
});
