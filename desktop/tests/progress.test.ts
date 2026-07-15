import { describe, expect, it } from "vitest";
import { cleanTerminalText, parseProgress, redactLog } from "../src/main/progress";

describe("progress parser", () => {
  it("parses the main translate progress without matching nested alphabetic steps", () => {
    expect(parseProgress("translate ━━━━━ 25/100")).toMatchObject({
      percent: 25,
      stage: "翻译正文",
    });
    expect(parseProgress("Translate Paragraphs (1/1) 1/1").percent).toBeUndefined();
  });

  it("parses tqdm progress and reserves 100 percent for completion", () => {
    expect(parseProgress("render | 10/10 [00:01<00:00]").percent).toBe(99);
  });

  it("removes ANSI control sequences and redacts secrets", () => {
    const value = "\u001b[31mAuthorization: Bearer sk-secret-value\u001b[0m";
    expect(cleanTerminalText(value)).not.toContain("\u001b");
    const redacted = redactLog(value);
    expect(redacted).not.toContain("sk-secret-value");
    expect(redacted).toContain("<redacted>");
  });
});
