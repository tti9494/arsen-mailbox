import { describe, expect, it } from "vitest";
import { MAX_SEND_CHUNKS, splitMessageText, splitProblem } from "../public/js/message-split.js";
// @ts-expect-error browser module without declarations
import { validateMessageInput } from "../public/js/constants.js";
import { SPACE_LIMITS } from "../src/brand";

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const fits = (s: string) => [...s].length <= SPACE_LIMITS.message_chars && bytes(s) <= SPACE_LIMITS.message_bytes;

describe("splitMessageText", () => {
  it("leaves a message that fits untouched, without a counter", () => {
    expect(splitMessageText("  안녕  ")).toEqual([{ text: "안녕", rest: "안녕" }]);
    expect(splitMessageText("   ")).toEqual([]);
  });

  it("splits at paragraph boundaries and numbers the parts", () => {
    const paragraph = "가나다라마바사 ".repeat(300).trim(); // ~2,100 chars
    const chunks = splitMessageText([paragraph, paragraph, paragraph, paragraph].join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.text.startsWith(`(${i + 1}/${chunks.length}) `)).toBe(true);
      expect(fits(c.text)).toBe(true);
    });
    // every part is a whole number of paragraphs here, so nothing is cut mid-sentence
    expect(chunks[0].text.endsWith("마바사")).toBe(true);
  });

  it("respects the byte limit for Korean text and never loses content", () => {
    const source = "한".repeat(12000);
    const chunks = splitMessageText(source);
    expect(chunks.every((c) => fits(c.text))).toBe(true);
    const joined = chunks.map((c) => c.text.replace(/^\(\d+\/\d+\) /, "")).join("");
    expect(joined).toBe(source);
  });

  it("hard-cuts text without any whitespace and keeps surrogate pairs whole", () => {
    const chunks = splitMessageText("😀".repeat(7000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(fits(c.text)).toBe(true);
      expect(c.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("closes and reopens a code fence that crosses a split", () => {
    const code = "x = 1\n".repeat(1500);
    const chunks = splitMessageText("설명\n```py\n" + code + "```\n끝");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect((c.text.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("rest lets a failed send resume from the unsent part", () => {
    const source = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(2500)).join("\n\n");
    const chunks = splitMessageText(source);
    expect(chunks[0].rest).toBe(source);
    expect(source.endsWith(chunks[1].rest)).toBe(true);
    expect(chunks[1].rest.length).toBeLessThan(source.length);
  });

  it("refuses more parts than the per-minute send limit leaves room for", () => {
    expect(splitProblem("가".repeat(5000))).toBe("");
    expect(splitProblem("가".repeat(SPACE_LIMITS.message_chars * MAX_SEND_CHUNKS))).toBe("too_many");
    expect(validateMessageInput("가".repeat(SPACE_LIMITS.message_chars + 1))).not.toBe("");
    expect(validateMessageInput("가".repeat(SPACE_LIMITS.message_chars + 1), { split: true })).toBe("");
    expect(validateMessageInput("가".repeat(40000), { split: true })).not.toBe("");
  });
});
