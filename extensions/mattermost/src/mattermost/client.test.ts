import { describe, expect, it, vi } from "vitest";
import { createMattermostClient, deleteMattermostPost, patchMattermostPost } from "./client.js";

describe("mattermost client", () => {
  it("request returns undefined on 204 responses", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    const result = await client.request<unknown>("/anything", { method: "DELETE" });
    expect(result).toBeUndefined();
  });

  // Test 14: patchMattermostPost calls PUT /posts/{id}/patch
  it("patchMattermostPost calls PUT /api/v4/posts/{id}/patch", async () => {
    const patchedPost = { id: "post-abc", message: "updated text" };
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify(patchedPost), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    const result = await patchMattermostPost(client, "post-abc", { message: "updated text" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/posts/post-abc/patch");
    expect(calledInit.method).toBe("PUT");
    expect(JSON.parse(calledInit.body as string)).toEqual({ message: "updated text" });
    expect(result).toEqual(patchedPost);
  });

  // Test 15: deleteMattermostPost calls DELETE /posts/{id}
  it("deleteMattermostPost calls DELETE /api/v4/posts/{id}", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, { status: 204 });
    });

    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "test-token",
      fetchImpl: fetchImpl as any,
    });

    await deleteMattermostPost(client, "post-xyz");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/posts/post-xyz");
    expect(calledUrl).not.toContain("/patch");
    expect(calledInit.method).toBe("DELETE");
  });
});
