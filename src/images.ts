import { dayCount, dayStart } from "./budget";
import { DEFAULT_IMAGE_EDGE, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, type ImageData } from "./image-data";
import { Refused } from "./policy";

export const DEFAULT_IMAGE_BYTES = 48_000;
export const IMAGE_SPACE_BYTES = 20_000_000;
export const IMAGE_SITE_BYTES = 300_000_000;
export const IMAGE_SPACE_DAILY = 10;
export const IMAGE_SITE_DAILY = 150;
const IMAGE_PARTICIPANT_MINUTE = 2;
export const IMAGE_WRITE_RESERVE = 40;

const scopes = {
  site_storage: "우편함의 이미지 저장 한도에 도달했습니다.",
  space_storage: "이 공간의 이미지 저장 한도에 도달했습니다.",
  site_daily: "오늘 우편함의 이미지 올리기 한도에 도달했습니다. UTC 자정(한국 시각 오전 9시) 이후 다시 시도해 주세요.",
  space_daily: "오늘 이 공간의 이미지 올리기 한도에 도달했습니다. UTC 자정(한국 시각 오전 9시) 이후 다시 시도해 주세요.",
  participant_minute: "이미지를 너무 자주 올렸습니다. 잠시 뒤 다시 시도해 주세요.",
} as const;
type Scope = keyof typeof scopes;

export class ImageLimit extends Refused {
  constructor(readonly scope: Scope, now = Math.floor(Date.now() / 1000)) {
    const minute = scope === "participant_minute";
    super(minute ? "rate_limited" : "quota", minute ? 60 - now % 60 : scope.endsWith("_daily") ? 86400 - now % 86400 : undefined);
  }
  get messageForUser() { return scopes[this.scope]; }
}

export function imageLimit(error: unknown): ImageLimit | undefined {
  const scope = /CHECK constraint failed: image_(\w+)/.exec(String(error))?.[1];
  if (scope && Object.hasOwn(scopes, scope)) return new ImageLimit(scope as Scope);
}

export type ImageSummary = { mime: string; bytes: number; width: number; height: number };
type ImageColumns = {
  image_mime: string | null;
  image_bytes: number | null;
  image_width: number | null;
  image_height: number | null;
};

export const IMAGE_SUMMARY_SQL =
  "i.mime AS image_mime,i.bytes AS image_bytes,i.width AS image_width,i.height AS image_height";

export function attachImageSummary<T extends ImageColumns>(row: T) {
  const { image_mime, image_bytes, image_width, image_height, ...fields } = row;
  return {
    ...fields,
    ...(image_mime ? { image: { mime: image_mime, bytes: image_bytes!, width: image_width!, height: image_height! } } : {}),
  };
}

export const imageUploadsOn = (value: string | undefined) => value === "on";
export interface ImageSettings {
  IMAGE_MAX_BYTES?: string;
  IMAGE_MAX_EDGE?: string;
  IMAGE_SPACE_DAILY?: string;
  IMAGE_SITE_DAILY?: string;
  IMAGE_SPACE_BYTES?: string;
  IMAGE_SITE_BYTES?: string;
}

function limit(setting: string | undefined, fallback: number, maximum: number) {
  if (!setting?.trim() || !/^\d+$/.test(setting.trim())) return fallback;
  return Math.max(1, Math.min(Number(setting), maximum));
}

export function imageUsageLimits(env: ImageSettings) {
  const edge = env.IMAGE_MAX_EDGE;
  return {
    image_max_bytes: limit(env.IMAGE_MAX_BYTES, DEFAULT_IMAGE_BYTES, MAX_IMAGE_BYTES),
    image_max_edge: limit(Number(edge) === 0 ? undefined : edge, DEFAULT_IMAGE_EDGE, MAX_IMAGE_EDGE),
    images_per_day: limit(env.IMAGE_SPACE_DAILY, IMAGE_SPACE_DAILY, 500),
    site_images_per_day: limit(env.IMAGE_SITE_DAILY, IMAGE_SITE_DAILY, 5_000),
    image_storage_bytes: limit(env.IMAGE_SPACE_BYTES, IMAGE_SPACE_BYTES, 300_000_000),
    site_image_storage_bytes: limit(env.IMAGE_SITE_BYTES, IMAGE_SITE_BYTES, 1_000_000_000),
  };
}

const storage = "(SELECT COALESCE(SUM(bytes),0) FROM image_storage WHERE owner_id=?)";

export function imageBudget(db: D1Database, owner: string, participant: string, bytes: number, now: number, limits: ReturnType<typeof imageUsageLimits>) {
  const day = now - now % 86400;
  const window = now - now % 60;
  const require = (scope: Scope, condition: string, ...values: (number | string)[]) =>
    db.prepare("INSERT INTO image_assertion(failure) SELECT '" + scope + "' WHERE NOT (" + condition + ")").bind(...values);
  const hit = (bucket: string, subject: string, start: number) => db.prepare(
    "INSERT INTO rate_hits(bucket,subject,window_start,count) SELECT ?,?,?,1 WHERE changes()=1" +
    " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=count+1",
  ).bind(bucket, subject, start);
  return {
    checks: [
      require("space_storage", storage + "+?<=?", owner, bytes, limits.image_storage_bytes),
      require("site_storage", storage + "+?<=?", "", bytes, limits.site_image_storage_bytes),
      require("space_daily", dayCount + "<?", "image_space_day", owner, day, limits.images_per_day),
      require("site_daily", dayCount + "<?", "image_site_day", "all", day, limits.site_images_per_day),
      require("participant_minute", dayCount + "<?", "image_upload", participant, window, IMAGE_PARTICIPANT_MINUTE),
    ],
    hits: [hit("image_space_day", owner, day), hit("image_site_day", "all", day), hit("image_upload", participant, window)],
  };
}

export async function imageDigest(data: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function saveImage(db: D1Database, room: string, owner: string, image: ImageData, sha: string, now: number) {
  const { data, mime, width, height } = image;
  // D1 serializes byte-array bindings as JSON numbers. SQLite decodes the native hex string into a BLOB.
  return db.prepare(
    "INSERT INTO message_images(message_id,room_id,owner_id,mime,bytes,width,height,sha256,data,created_at)" +
    " SELECT last_insert_rowid(),?,?,?,?,?,?,?,unhex(?),? WHERE changes()=1",
  ).bind(room, owner, mime, data.length, width, height, sha, data.toHex(), now);
}

export async function loadImage(db: D1Database, guards: D1PreparedStatement[], room: string, id: number, cutoff: number) {
  const results = await db.batch([...guards, db.prepare(
    "SELECT hex(i.data) AS data,i.mime,i.bytes FROM message_images i JOIN messages m ON m.id=i.message_id" +
    " WHERE i.message_id=? AND i.room_id=? AND m.room_id=? AND m.created_at>?",
  ).bind(id, room, room, cutoff)]);
  const row = results.at(-1)?.results[0] as { mime: string; data: string; bytes: number } | undefined;
  if (!row) throw new Refused("not_found");
  const suffix = row.mime === "image/jpeg" ? "jpg" : row.mime.slice(6);
  return new Response(Uint8Array.fromHex(row.data), { headers: {
    "content-type": row.mime,
    "content-length": String(row.bytes),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": 'inline; filename="image.' + suffix + '"',
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
  } });
}

export const imageUsageSql = "COALESCE((SELECT bytes FROM image_storage WHERE owner_id=?),0) AS image_storage_bytes," +
  dayCount + " AS images_today";
export const imageUsageArgs = (space: string) => [space, "image_space_day", space, dayStart()] as const;
