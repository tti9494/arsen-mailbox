// Input rules and preview-bot refusal.

import { SPACE_LIMITS } from "./brand";

export const MAX_TEXT = SPACE_LIMITS.message_chars;
export const MAX_NAME = 32;

/** Fixed code only; never carries the submitted value. */
export class Refused extends Error {
  constructor(readonly code: string, readonly retryAfter?: number) {
    super(code);
  }
}

// Common secret families plus one-time codes, cloud/API tokens and this mailbox's own keys.
export const SENSITIVE = new RegExp(
  [
    String.raw`-----BEGIN .*PRIVATE KEY-----`,
    String.raw`\b(?:sk-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9_-]+)`,
    String.raw`\bBearer\s+\S+`,
    String.raw`(?:password|비밀번호|주민등록번호|계좌번호)\s*[:=]`,
    String.raw`\b[0-9]{6}[- ]?[1-4][0-9]{6}\b`,
    String.raw`(?:비밀번호|비번|암호|\bpassword|\bpasswd|\bpw)\s*(?:는|은|:|=|is)?\s*(?=\S*[0-9!@#$%^&*])[A-Za-z0-9!@#$%^&*_.+-]{4,}`,
    String.raw`(?:인증\s*(?:번호|코드)|확인\s*코드|보안\s*코드|\botp|verification\s*code|auth(?:entication)?\s*code)\D{0,12}\d{4,8}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\bam[kotsri]_[A-Za-z0-9_-]{20,}`,
  ].join("|"),
  "iu",
);

// C0/C1 controls (incl. NEL U+0085), Unicode line/paragraph separators (U+2028/2029: some readers break lines
// there, which would defeat the 4-space indentation contract), bidi overrides and lone surrogates.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]|\p{Cs}/u;

/** NFC, CRLF->LF, no control/bidi-override/lone-surrogate characters, 1..MAX_TEXT chars, no secret-looking text. */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") throw new Refused("text_missing");
  if (CONTROL.test(value.replace(/\r\n?/g, "\n"))) throw new Refused("text_invalid");
  const text = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!text) throw new Refused("text_missing");
  if ([...text].length > MAX_TEXT) throw new Refused("text_too_long");
  if (SENSITIVE.test(text)) throw new Refused("text_sensitive");
  return text;
}

const NAME = /^[\p{L}\p{N} _.-]+$/u;

export function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new Refused("name_invalid");
  const name = value.normalize("NFC").trim();
  if (!name || [...name].length > MAX_NAME || !NAME.test(name) || SENSITIVE.test(name)) {
    throw new Refused("name_invalid");
  }
  return name;
}

// Link-preview / crawler user agents: they may never write and never read room content.
const PREVIEW_BOTS = new RegExp(
  [
    "slackbot", "slack-imgproxy", "twitterbot", "facebookexternalhit", "facebot", "discordbot", "telegrambot",
    "whatsapp", "kakaotalk-scrap", "kakaostory", "linkedinbot", "skypeuripreview", "microsoftpreview", "teamsbot",
    "iframely", "embedly", "redditbot", "pinterest", "googlebot", "google-pagerenderer", "adsbot", "bingbot",
    "bingpreview", "yeti", "daumoa", "applebot", "duckduckbot", "yandex", "baiduspider", "mastodon", "pleroma",
    "bluesky", "line-poker", "snapchat", "vkshare", "outbrain", "quora link preview", "nuzzel", "w3c_validator",
    "ahrefsbot", "semrushbot", "petalbot", "bytespider", "headlesschrome",
  ].join("|"),
  "i",
);

export function isPreviewBot(headers: Headers): boolean {
  const purpose = `${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""} ${headers.get("x-purpose") ?? ""}`
    .toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("preview")) return true;
  const agent = headers.get("user-agent");
  return agent !== null && PREVIEW_BOTS.test(agent);
}

/** [limit, window seconds]; counted in D1 fixed windows, so they hold across isolates and locations. */
export const LIMITS: Record<string, [number, number]> = {
  read: [20, 60], // per participant
  send: [6, 60], // per participant
  send_day: [200, 86400], // per participant
  image_upload: [2, 60], // successful attachments per participant
  auth_fail: [30, 60], // per source address (hashed)
  auth_fail_day: [300, 86400], // also bound one source’s daily reserve
  space: [60, 60],
  space_day: [10_000, 86400],
  admin: [60, 60], // per owner
};
