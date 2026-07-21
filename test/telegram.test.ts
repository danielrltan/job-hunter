import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessage, stripHtml } from "../src/telegram";

const reply = (status: number) =>
  new Response(status === 200 ? "{}" : `{"error_code":${status}}`, { status });

afterEach(() => vi.unstubAllGlobals());

/** Capture what would go to Telegram, and control what comes back. */
function mockTelegram(...responses: number[]) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return Promise.resolve(reply(responses[i++] ?? 200));
  });
  return calls;
}

describe("stripHtml", () => {
  it("unwraps tags and restores escaped characters", () => {
    expect(stripHtml("<b>A&lt;b&gt; &amp; Co</b>")).toBe("A<b> & Co");
  });
});

describe("sendMessage", () => {
  it("sends formatted HTML on the happy path", async () => {
    const calls = mockTelegram(200);
    await sendMessage("<b>hi</b>", "tok", "1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: "<b>hi</b>", parse_mode: "HTML" });
  });

  /**
   * The listing must still arrive. Commit state is only saved after a
   * successful send, so a message Telegram will never accept would otherwise
   * wedge this tick and every tick after it.
   */
  it("falls back to plain text when Telegram rejects the formatting", async () => {
    const calls = mockTelegram(400, 200);
    await sendMessage("<b>Acme</b> &amp; Co", "tok", "1");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ text: "Acme & Co" });
    expect(calls[1]!.parse_mode).toBeUndefined();
  });

  it("throws when even plain text is refused", async () => {
    mockTelegram(400, 400);
    await expect(sendMessage("<b>x</b>", "tok", "1")).rejects.toThrow(/formatted and plain/);
  });

  // 429 and 5xx are transient, so the same message should be retried next tick
  // rather than silently downgraded.
  it("throws without downgrading on a transient failure", async () => {
    const calls = mockTelegram(429);
    await expect(sendMessage("<b>x</b>", "tok", "1")).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });
});
