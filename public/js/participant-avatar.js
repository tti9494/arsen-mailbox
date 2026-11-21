export const AVATAR_PRESETS = ["chatgpt", "claude", "cue", "gemini", "hark", "instinct", "keyring", "muse", "pickle", "vooy"];
export const PARTICIPANT_FILTERS = [
  ["all", "전체"], ["human", "사람"], ["llm", "LLM"], ["assistant", "비서"],
];

export function participantRole(p) {
  if (p.kind === "human" || p.is_owner) return "human";
  return ["claude", "chatgpt", "gemini"].includes(p.ai_type) ? "llm" : "assistant";
}
export function participantRoleLabel(p) {
  return PARTICIPANT_FILTERS.find(([key]) => key === participantRole(p))[1];
}

export function participantNotes(p) {
  if (!p?.device_label && !p?.role_note) return null;
  return el("span", { className: "participant-notes" },
    p.device_label ? el("span", { className: "chip participant-device", text: p.device_label }) : null,
    p.role_note ? el("span", { className: "participant-role-note", text: p.role_note }) : null,
  );
}

// Some browsers add a color profile to canvas WebP output. Keep only the opaque raster frame.
function rasterFrame(bytes) {
  const view = new DataView(bytes.buffer);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) break;
    if (name === "VP8 " || name === "VP8L") {
      const image = new Uint8Array(20 + size + (size % 2));
      image.set([82, 73, 70, 70]);
      new DataView(image.buffer).setUint32(4, image.length - 8, true);
      image.set([87, 69, 66, 80], 8);
      image.set(bytes.subarray(offset, end), 12);
      return image;
    }
    offset = end + (size % 2);
  }
  return null;
}

export async function avatarThumbnail(file) {
  if (!file || file.size < 12 || file.size > 2 * 1024 * 1024) throw new Error("2MB 이하의 이미지를 선택하세요.");
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...header.slice(start, end));
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => byte === header[i]);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw new Error("실제 PNG, JPEG 또는 WebP 이미지만 사용할 수 있습니다.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("이 이미지를 읽을 수 없습니다."); }
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error("가로와 세로는 각각 4096px 이하여야 합니다.");
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("이 브라우저에서 작은 이미지를 만들 수 없습니다.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 96, 96);
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
    for (const quality of [0.72, 0.45, 0.25]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob?.type !== "image/webp") continue;
      const frame = rasterFrame(new Uint8Array(await blob.arrayBuffer()));
      if (frame && frame.length <= 8_192) return btoa(String.fromCharCode(...frame));
    }
    throw new Error("이 브라우저에서 저장 가능한 WebP 이미지를 만들 수 없습니다.");
  } finally {
    bitmap.close();
  }
}
import { el } from "./dom.js?v=2.3.0";
