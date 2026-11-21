// 2.3 API 계약 전용 클라이언트 (1차 검수 보안 교훈 반영)
// - redirect: "error" 고정(리다이렉트 시 열쇠 헤더 유출 원천 차단)
// - HTTP 401 / 403 응답은 본문 JSON 여부·형식과 무관하게 무조건 확정 거절(definitive = true) 처리
// - 공간 키는 Authorization: Bearer ams_... 헤더로만, 참가자 키는 X-Mailbox-Key: amk_... 헤더로만 전달
// - 쿼리·본문·오류 객체·콘솔에 열쇠 원문을 절대 남기지 않음

import { DEFINITIVE_ERRORS } from "./constants.js?v=2.3.0";

export class ApiError extends Error {
  constructor(code, status = 0, retryAfter = null, definitive = false) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.definitive = Boolean(
      definitive || status === 401 || status === 403 || DEFINITIVE_ERRORS.has(code),
    );
  }
}

export function isAuthRefusal(err) {
  return Boolean(
    err &&
      (err.status === 401 ||
        err.status === 403 ||
        err.code === "unauthorized" ||
        err.code === "forbidden" ||
        err.code === "key_epoch_invalid"),
  );
}

export async function apiRequest(
  path,
  { method = "GET", body = undefined, spaceKey = null, participantKey = null, image, caption, relayedFor, asBlob } = {},
) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("offline", 0, null, false);
  }

  const headers = new Headers();
  headers.set("accept", asBlob ? "image/png, image/jpeg, image/webp" : "application/json");

  if (spaceKey && participantKey) {
    throw new ApiError("invalid", 400, null, false);
  }
  if (spaceKey) {
    headers.set("authorization", `Bearer ${spaceKey}`);
  } else if (participantKey) {
    headers.set("x-mailbox-key", participantKey);
  }

  let serialized;
  if (image instanceof Blob && method === "POST") {
    headers.set("content-type", image.type);
    if (caption) headers.set("x-mailbox-text", encodeURIComponent(caption));
    if (relayedFor) headers.set("x-mailbox-relayed-for", relayedFor);
    serialized = image;
  } else if (body !== undefined && method !== "GET" && method !== "HEAD") {
    headers.set("content-type", "application/json");
    serialized = JSON.stringify(body);
  }

  let res;
  try {
    res = await window.fetch(path, {
      method,
      headers,
      body: serialized,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    const code = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "network";
    throw new ApiError(code, 0, null, false);
  }

  // HTTP 401 / 403은 응답 본문 형식과 무관하게 무조건 확정 거절 처리
  const statusDefinitive = res.status === 401 || res.status === 403;

  if (res.ok && asBlob) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(res.headers.get("content-type")))
      throw new ApiError("image_invalid", res.status);
    return res.blob();
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const fallbackCode =
      res.status === 401
        ? "unauthorized"
        : res.status === 403
          ? "forbidden"
          : res.status === 404
            ? "not_found"
            : res.status === 429
              ? "rate_limited"
              : res.status === 503
                ? "key_epoch_invalid"
                : "invalid";

    const imageScopes = ["site_storage", "space_storage", "site_daily", "space_daily", "participant_minute"];
    const code = statusDefinitive
      ? res.status === 401
        ? "unauthorized"
        : "forbidden"
      : data?.error === "quota" && ["service_day", "space_day", "space_operation", "space_posts"].includes(data.scope)
        ? data.scope + "_quota"
      : ["quota", "rate_limited"].includes(data?.error) && imageScopes.includes(data.scope)
        ? "image_" + data.scope
      : typeof data?.error === "string"
        ? data.error
        : fallbackCode;

    const retryHeader = Number(res.headers.get("retry-after"));
    const retryAfter = Number.isFinite(data?.retry_after)
      ? data.retry_after
      : Number.isFinite(retryHeader) && retryHeader > 0
        ? retryHeader
        : null;

    const error = new ApiError(code, res.status, retryAfter, statusDefinitive);
    if (Number.isSafeInteger(data?.image_max_bytes) && data.image_max_bytes > 0) error.imageMaxBytes = data.image_max_bytes;
    if (Number.isSafeInteger(data?.image_max_edge) && data.image_max_edge > 0) error.imageMaxEdge = data.image_max_edge;
    if (code === "space_posts_quota" && Number.isSafeInteger(data.limit) && data.limit > 0) error.postLimit = data.limit;
    throw error;
  }

  return data ?? {};
}
