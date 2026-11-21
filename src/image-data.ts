import { Refused } from "./policy";

export const MAX_IMAGE_BYTES = 1_000_000;
export const imageInputLimit = (maximum: number) => maximum;
export const imageJsonLimit = (maximum: number) => Math.ceil(imageInputLimit(maximum) / 3) * 4 + 16_384;
export const MAX_IMAGE_EDGE = 4096;
export const DEFAULT_IMAGE_EDGE = 2048;
const MAX_SECTIONS = 512;

const MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = typeof MIME[number];
export type ImageData = { mime: ImageMime; data: Uint8Array; width: number; height: number };
type Dimensions = { width: number; height: number };

function invalid(): never { throw new Refused("image_invalid"); }
function unsupported(): never { throw new Refused("image_unsupported"); }

export async function readImageInput(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > max) throw new Refused("image_too_large");
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        void reader.cancel().catch(() => {});
        throw new Refused("image_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

export function decodeImageBase64(value: unknown, maximum = MAX_IMAGE_BYTES): Uint8Array {
  if (typeof value !== "string" || !value.length) invalid();
  if (value.length > Math.ceil(imageInputLimit(maximum) / 3) * 4) throw new Refused("image_too_large");
  if (value.length % 4 !== 0 || /[^a-z0-9+/=]/i.test(value)) invalid();
  try { return Uint8Array.fromBase64(value, { lastChunkHandling: "strict" }); }
  catch { return invalid(); }
}

export function inspectImage(mime: unknown, data: Uint8Array, maximum = MAX_IMAGE_BYTES, maximumEdge = DEFAULT_IMAGE_EDGE): ImageData {
  if (!MIME.includes(mime as ImageMime)) unsupported();
  if (data.length > imageInputLimit(maximum)) throw new Refused("image_too_large");
  const bytes = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info: Dimensions & { data?: Uint8Array } = mime === "image/png" ? png(data, bytes, maximumEdge) : mime === "image/jpeg" ? jpeg(data, maximumEdge) : webp(data, bytes);
  if (info.width > maximumEdge || info.height > maximumEdge) throw new Refused("image_dimensions");
  if (!info.width || !info.height) invalid();
  const clean = info.data ?? data;
  if (clean.length > maximum) throw new Refused("image_too_large");
  return { mime: mime as ImageMime, data: clean, width: info.width, height: info.height };
}

function collect(data: Uint8Array, sections: [number, number][]) {
  const length = sections.reduce((size, [start, end]) => size + end - start, 0);
  if (length === data.length) return data;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const [start, end] of sections) {
    result.set(data.subarray(start, end), offset);
    offset += end - start;
  }
  return result;
}

const CRC_FIRST = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});
const CRC = [CRC_FIRST];
for (let i = 1; i < 8; i++) {
  CRC.push(CRC[i - 1].map((value) => (value >>> 8) ^ CRC_FIRST[value & 255]));
}

function crc32(data: Uint8Array, view: DataView, start: number, end: number) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC;
  let crc = 0xffffffff;
  let offset = start;
  for (; offset + 8 <= end; offset += 8) {
    const word = crc ^ view.getUint32(offset, true);
    crc = t7[word & 255] ^ t6[(word >>> 8) & 255] ^ t5[(word >>> 16) & 255] ^ t4[word >>> 24] ^
      t3[data[offset+4]] ^ t2[data[offset+5]] ^ t1[data[offset+6]] ^ t0[data[offset+7]];
  }
  for (; offset < end; offset++) crc = (crc >>> 8) ^ t0[(crc ^ data[offset]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const pngDepths: Readonly<Record<number, number[]>> = {
  0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
};

function png(data: Uint8Array, view: DataView, maximumEdge: number): Dimensions & { data: Uint8Array } {
  if (data.length < 45 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) invalid();
  const sections: [number, number][] = [[0, 8]];
  let width = 0, height = 0, color = 0, depth = 0, palette = 0, transparent = false;
  let idat = 0, idatEnded = false, zHeader = 0;
  for (let offset = 8, count = 1; offset + 12 <= data.length && count <= MAX_SECTIONS; count++) {
    const size = view.getUint32(offset);
    const start = offset + 8, end = start + size;
    if (end + 4 > data.length) invalid();
    const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    if (["acTL","fcTL","fdAT"].includes(type)) unsupported();
    if (count === 1 && type !== "IHDR") invalid();
    if (crc32(data, view, offset + 4, end) !== view.getUint32(end)) invalid();
    if (idat && type !== "IDAT") idatEnded = true;

    switch (type) {
      case "IHDR":
        if (count !== 1 || size !== 13) invalid();
        width = view.getUint32(start);
        height = view.getUint32(start + 4);
        depth = data[start+8];
        color = data[start+9];
        if (!pngDepths[color]?.includes(depth) || data[start+10] || data[start+11] || data[start+12] > 1) invalid();
        if (width > maximumEdge || height > maximumEdge) throw new Refused("image_dimensions");
        break;
      case "PLTE":
        if (palette || idat || transparent || color === 0 || color === 4 || !size || size > 768 || size % 3) invalid();
        palette = size / 3;
        if (color === 3 && palette > (1 << depth)) invalid();
        break;
      case "tRNS":
        if (transparent || idat) invalid();
        if ((color === 0 && size !== 2) || (color === 2 && size !== 6) ||
            (color === 3 && (!palette || !size || size > palette)) || color === 4 || color === 6) invalid();
        transparent = true;
        break;
      case "IDAT":
        if (idatEnded || (color === 3 && !palette)) invalid();
        for (let i = 0; i < size && idat + i < 2; i++) zHeader = (zHeader << 8) | data[start+i];
        idat += size;
        break;
      case "IEND":
        if (size || end + 4 !== data.length || idat < 6 ||
            (zHeader & 0x0f00) !== 0x0800 || zHeader >>> 12 > 7 || zHeader % 31 || (zHeader & 32)) invalid();
        sections.push([offset, end + 4]);
        return { width, height, data: collect(data, sections) };
      default:
        if (!(data[offset+4] & 32)) invalid();
        offset = end + 4;
        continue;
    }
    sections.push([offset, end + 4]);
    offset = end + 4;
  }
  return invalid();
}

function jpeg(data: Uint8Array, maximumEdge: number): Dimensions & { data: Uint8Array } {
  if (data[0] !== 255 || data[1] !== 0xd8) invalid();
  const sections: [number, number][] = [[0, 2]];
  let width = 0, height = 0, frame = false, scans = 0;
  const components = new Set<number>();
  for (let offset = 2, segments = 0; offset < data.length && ++segments <= MAX_SECTIONS;) {
    const start = offset;
    if (data[offset++] !== 255) invalid();
    while (data[offset] === 255) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!scans || offset !== data.length) invalid();
      sections.push([start, offset]);
      return { width, height, data: collect(data, sections) };
    }
    if (offset + 2 > data.length) invalid();
    const size = (data[offset] << 8) | data[offset+1];
    let end = offset + size;
    if (size < 2 || end > data.length) invalid();
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      offset = end; // All APP segments can carry private data or thumbnails.
      continue;
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || size < 11 || data[offset+2] !== 8) invalid();
      height = (data[offset+3] << 8) | data[offset+4];
      width = (data[offset+5] << 8) | data[offset+6];
      if (!width || !height) invalid();
      if (width > maximumEdge || height > maximumEdge) throw new Refused("image_dimensions");
      const count = data[offset+7];
      if (![1, 3].includes(count) || size !== 8 + count * 3) invalid();
      for (let i = offset+8; i < end; i += 3) {
        if (components.has(data[i]) || data[i+1] >> 4 < 1 || data[i+1] >> 4 > 4 ||
            (data[i+1] & 15) < 1 || (data[i+1] & 15) > 4 || data[i+2] > 3) invalid();
        components.add(data[i]);
      }
      frame = true;
    } else if (marker === 0xda) {
      if (!frame || size < 8 || ++scans > 64) invalid();
      const count = data[offset+2];
      if (!count || count > components.size || size !== 6 + count * 2) invalid();
      const selected = new Set<number>();
      for (let i = offset+3; i < end-3; i += 2) {
        if (!components.has(data[i]) || selected.has(data[i]) || data[i+1] >> 4 > 3 || (data[i+1] & 15) > 3) invalid();
        selected.add(data[i]);
      }
      const pixels = end;
      while (end < data.length) {
        if (data[end] !== 255) { end++; continue; }
        const markerStart = end++;
        while (data[end] === 255) end++;
        if (data[end] === 0 || (data[end] >= 0xd0 && data[end] <= 0xd7)) { end++; continue; }
        end = markerStart;
        break;
      }
      if (end === pixels || end >= data.length) invalid();
    } else if (marker === 0xdd) {
      if (size !== 4) invalid();
    } else if (marker === 0xdb || marker === 0xc4) {
      if (size <= 3) invalid();
    } else return invalid();
    sections.push([start, end]);
    offset = end;
  }
  return invalid();
}

function webp(data: Uint8Array, view: DataView): Dimensions & { data?: Uint8Array } {
  if (data.length < 25 || view.getUint32(0) !== 0x52494646 ||
      view.getUint32(4, true) !== data.length - 8 || view.getUint32(8) !== 0x57454250) invalid();
  let expectedWidth = 0, expectedHeight = 0, width = 0, height = 0, alpha = false, featureAlpha = false;
  let featureProfile = false;
  let discardedProfile: [number, number] | undefined;
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length || width) invalid();
    const tag = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8, end = start + size;
    if (end + (size % 2) > data.length || (size % 2 && data[end])) invalid();
    if (tag === 0x56503858) { // VP8X
      if (offset !== 12 || size !== 10 || (data[start] & 0xc1) || data[start+1] || data[start+2] || data[start+3]) invalid();
      if (data[start] & 0x0e) unsupported(); // EXIF, XMP and animation extensions.
      featureProfile = Boolean(data[start] & 0x20);
      featureAlpha = Boolean(data[start] & 0x10);
      expectedWidth = 1 + (view.getUint32(start+3, true) >>> 8);
      expectedHeight = 1 + (view.getUint32(start+6, true) >>> 8);
    } else if (tag === 0x49434350) { // Canvas encoders may add an ICC profile. Omit it from storage.
      if (!featureProfile || offset !== 30 || discardedProfile || !size) invalid();
      discardedProfile = [offset, end + size % 2];
    } else if (tag === 0x414c5048) { // ALPH
      if (!featureAlpha || alpha || size < 2 || (data[start] & 0xc0) || (data[start] & 3) > 1) invalid();
      alpha = true;
    } else if (tag === 0x56503820) { // VP8
      if (size < 11 || (data[start] & 1) || data[start+3] !== 0x9d ||
          data[start+4] !== 1 || data[start+5] !== 0x2a ||
          (view.getUint32(start, true) & 0xffffff) >>> 5 > size - 10) invalid();
      width = view.getUint16(start+6, true);
      height = view.getUint16(start+8, true);
      if ((width | height) & 0xc000 || alpha !== featureAlpha) invalid();
    } else if (tag === 0x5650384c) { // VP8L
      if (size < 6 || data[start] !== 0x2f || alpha) invalid();
      const value = view.getUint32(start+1, true);
      if (value >>> 29 || (expectedWidth && Boolean(value & 0x10000000) !== featureAlpha)) invalid();
      width = (value & 0x3fff) + 1;
      height = ((value >>> 14) & 0x3fff) + 1;
    } else return unsupported();
    offset = end + size % 2;
  }
  if (expectedWidth && (width !== expectedWidth || height !== expectedHeight)) invalid();
  if (featureProfile !== Boolean(discardedProfile)) invalid();
  if (!discardedProfile) return { width, height };
  const clean = collect(data, [[0, discardedProfile[0]], [discardedProfile[1], data.length]]);
  new DataView(clean.buffer).setUint32(4, clean.length - 8, true);
  clean[20] &= ~0x20;
  return { width, height, data: clean };
}
