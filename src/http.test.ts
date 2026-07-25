import { describe, expect, it } from "vitest";
import { fetchWithBackoff, USER_AGENT } from "./http.js";

describe("fetchWithBackoff header merging", () => {
  it("uses the default USER_AGENT when no custom user-agent header is supplied", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200 } as unknown as Response;
    }) as typeof fetch;

    await fetchWithBackoff("https://example.com", { fetchImpl });

    expect(capturedHeaders?.["User-Agent"]).toBe(USER_AGENT);
  });

  it("a caller-supplied lowercase user-agent header REPLACES the default, not appends to it", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200 } as unknown as Response;
    }) as typeof fetch;

    const customUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36";
    await fetchWithBackoff("https://example.com", {
      fetchImpl,
      headers: { "user-agent": customUA, accept: "text/html" },
    });

    // The default USER_AGENT constant must NOT appear anywhere in the merged headers object.
    const allHeaderValues = Object.values(capturedHeaders ?? {}).join(" | ");
    expect(allHeaderValues).not.toContain(USER_AGENT);
    expect(capturedHeaders?.["user-agent"]).toBe(customUA);
    expect(capturedHeaders?.["accept"]).toBe("text/html");
  });

  it("a caller-supplied mixed-case User-Agent header also replaces the default", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200 } as unknown as Response;
    }) as typeof fetch;

    await fetchWithBackoff("https://example.com", {
      fetchImpl,
      headers: { "User-Agent": "CustomBot/1.0" },
    });

    expect(capturedHeaders?.["User-Agent"]).toBe("CustomBot/1.0");
    expect(Object.keys(capturedHeaders ?? {}).filter((k) => k.toLowerCase() === "user-agent")).toHaveLength(1);
  });
});
