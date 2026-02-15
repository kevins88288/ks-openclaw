import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock google-auth-library - must be before imports
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: vi.fn().mockResolvedValue("mock-gcp-token-12345"),
    }),
  })),
}));

// Mock file system - must be before imports
vi.mock("../infra/json-file.js", () => ({
  loadJsonFile: vi.fn(),
  saveJsonFile: vi.fn(),
}));

// Mock config paths - must be before imports
vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn().mockReturnValue("/mock/state/dir"),
}));

import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveGcpAdcToken } from "./gcp-adc-token.js";

describe("resolveGcpAdcToken", () => {
  const mockLoadJsonFile = vi.mocked(loadJsonFile);
  const mockSaveJsonFile = vi.mocked(saveJsonFile);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached token if still valid", async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30 minutes from now
    mockLoadJsonFile.mockReturnValue({
      token: "cached-token-abc",
      expiresAt,
      updatedAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    });

    const result = await resolveGcpAdcToken();

    expect(result.token).toBe("cached-token-abc");
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.source).toContain("cache:");
    expect(mockSaveJsonFile).not.toHaveBeenCalled();
  });

  it("fetches fresh token when cache is expired", async () => {
    const expiredAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago (expired)
    mockLoadJsonFile.mockReturnValue({
      token: "expired-token",
      expiresAt: expiredAt,
      updatedAt: Date.now() - 70 * 60 * 1000,
    });

    const result = await resolveGcpAdcToken();

    expect(result.token).toBe("mock-gcp-token-12345");
    expect(result.source).toBe("gcp-adc");
    expect(mockSaveJsonFile).toHaveBeenCalledWith(
      "/mock/state/dir/credentials/gcp-adc.token.json",
      expect.objectContaining({
        token: "mock-gcp-token-12345",
        expiresAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    );
  });

  it("fetches fresh token when cache is missing", async () => {
    mockLoadJsonFile.mockReturnValue(undefined);

    const result = await resolveGcpAdcToken();

    expect(result.token).toBe("mock-gcp-token-12345");
    expect(result.source).toBe("gcp-adc");
    expect(mockSaveJsonFile).toHaveBeenCalled();
  });

  it("fetches fresh token when cached token is within 5-minute safety margin", async () => {
    const expiresAt = Date.now() + 3 * 60 * 1000; // 3 minutes from now (within 5-min margin)
    mockLoadJsonFile.mockReturnValue({
      token: "almost-expired-token",
      expiresAt,
      updatedAt: Date.now() - 57 * 60 * 1000,
    });

    const result = await resolveGcpAdcToken();

    expect(result.token).toBe("mock-gcp-token-12345");
    expect(result.source).toBe("gcp-adc");
    expect(mockSaveJsonFile).toHaveBeenCalled();
  });

  it("handles invalid cache structure gracefully", async () => {
    mockLoadJsonFile.mockReturnValue({
      // Missing token field
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    const result = await resolveGcpAdcToken();

    expect(result.token).toBe("mock-gcp-token-12345");
    expect(mockSaveJsonFile).toHaveBeenCalled();
  });

  it("respects custom scopes", async () => {
    const { GoogleAuth } = await import("google-auth-library");
    mockLoadJsonFile.mockReturnValue(undefined);

    await resolveGcpAdcToken({
      scopes: ["https://www.googleapis.com/auth/aiplatform"],
    });

    expect(GoogleAuth).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/aiplatform"],
    });
  });

  it("uses default cloud-platform scope when not specified", async () => {
    const { GoogleAuth } = await import("google-auth-library");
    mockLoadJsonFile.mockReturnValue(undefined);

    await resolveGcpAdcToken();

    expect(GoogleAuth).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  });

  it("throws error when google-auth-library returns no token", async () => {
    const { GoogleAuth } = await import("google-auth-library");
    // @ts-expect-error - mocking implementation override
    GoogleAuth.mockImplementationOnce(() => ({
      getClient: vi.fn().mockResolvedValue({
        getAccessToken: vi.fn().mockResolvedValue(null),
      }),
    }));
    mockLoadJsonFile.mockReturnValue(undefined);

    await expect(resolveGcpAdcToken()).rejects.toThrow("Failed to obtain GCP ADC access token");
  });

  it("stores token with correct cache path", async () => {
    mockLoadJsonFile.mockReturnValue(undefined);

    await resolveGcpAdcToken();

    expect(mockSaveJsonFile).toHaveBeenCalledWith(
      "/mock/state/dir/credentials/gcp-adc.token.json",
      expect.any(Object),
    );
  });

  it("sets 1-hour expiry for fetched tokens", async () => {
    mockLoadJsonFile.mockReturnValue(undefined);

    const before = Date.now();
    const result = await resolveGcpAdcToken();
    const after = Date.now();

    // Should be ~1 hour from now (GCP standard)
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600000);
    expect(result.expiresAt).toBeLessThanOrEqual(after + 3600000);
  });
});
