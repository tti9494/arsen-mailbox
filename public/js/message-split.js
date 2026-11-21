// 긴 글 자동 분할 (카톡식): 글 1건 한도를 넘는 입력을 문단·줄·문장 경계에서 여러 글로 나눕니다.
// - 서버 한도(src/brand.ts)와 같은 SPACE_LIMITS를 쓰며, 분당 쓰기 한도(6건) 안에서 최대 MAX_SEND_CHUNKS건까지 나눕니다.
// - 나눈 글에는 "(1/3) " 표시를 붙여 읽는 사람·비서가 순서를 알 수 있고, 같은 내용 연속 전송 거절도 피합니다.
// - 코드 블록(```)이 조각 사이에서 끊기면 앞 조각을 닫고 다음 조각에서 다시 엽니다.

import { SPACE_LIMITS } from "./constants.js?v=2.2.2";

export const MAX_SEND_CHUNKS = 5;
/** 번호 표시("(5/5) ")와 코드 블록 닫기·열기에 쓰는 여유 */
const RESERVE = 16;

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).byteLength;
const normalize = (raw) => String(raw ?? "").replace(/\r\n?/g, "\n").normalize("NFC").trim();

function fitsOne(text) {
  return [...text].length <= SPACE_LIMITS.max_chars && byteLength(text) <= SPACE_LIMITS.message_bytes;
}

/** `window` 안에서 가장 알맞은 자름 위치(UTF-16 인덱스). 앞쪽 40% 안에서만 자르면 비효율이라 그때는 끝에서 자릅니다. */
function cutPoint(window) {
  const floor = Math.floor(window.length * 0.4);
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    [...window.matchAll(/[.!?。！？…]["')\]」』]?\s/g)].map((m) => m.index + m[0].length - 1).pop() ?? -1,
    window.lastIndexOf(" "),
  ];
  for (const at of candidates) if (at >= floor) return at;
  return window.length;
}

/** 입력 하나를 보낼 글 목록으로 나눕니다. 한 건에 들어가면 [{text, rest}] 하나(번호 표시 없음).
 * `rest`는 이 글부터 남은 원문이라, 중간에 실패하면 그대로 입력창에 되돌릴 수 있습니다. */
export function splitMessageText(raw) {
  const source = normalize(raw);
  if (!source) return [];
  if (fitsOne(source)) return [{ text: source, rest: source }];

  const maxChars = SPACE_LIMITS.max_chars - RESERVE;
  const maxBytes = SPACE_LIMITS.message_bytes - RESERVE;
  const pieces = [];
  let offset = 0;
  let fenceOpen = false;

  while (offset < source.length) {
    const remaining = source.slice(offset);
    let end = 0;
    let chars = 0;
    let bytes = 0;
    for (const ch of remaining) {
      const b = byteLength(ch);
      if (chars + 1 > maxChars || bytes + b > maxBytes) break;
      chars += 1;
      bytes += b;
      end += ch.length;
    }
    const last = end >= remaining.length;
    const cut = last ? end : cutPoint(remaining.slice(0, end));
    let body = remaining.slice(0, cut).trimEnd();
    const start = offset;
    offset += cut;
    while (offset < source.length && /\s/.test(source[offset])) offset += 1;

    if (fenceOpen) body = "```\n" + body;
    fenceOpen = ((body.match(/```/g) ?? []).length % 2) === 1;
    if (fenceOpen && offset < source.length) body += "\n```";
    else if (offset >= source.length) fenceOpen = false;
    pieces.push({ body, rest: source.slice(start) });
  }

  const total = pieces.length;
  return pieces.map((piece, index) => ({ text: `(${index + 1}/${total}) ${piece.body}`, rest: piece.rest }));
}

/** 입력창 검증용: 나눠서도 다 못 보내면 오류 코드를 돌려줍니다. */
export function splitProblem(raw) {
  const chunks = splitMessageText(raw);
  return chunks.length > MAX_SEND_CHUNKS ? "too_many" : "";
}
