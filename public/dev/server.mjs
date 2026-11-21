// 로컬 루프백 전용 정적+목 API 서버 (127.0.0.1 바인드 전용)
// - Worker A(v2.ts)와 동일한 엄격 CSP 및 보안 헤더 적용
// - /dev/* 요청은 404로 차단해 배포 환경과 동일하게 격리

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockStore } from "./mock.js?v=2.3.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
};

const store = createMockStore(`http://${HOST}:${PORT}`);

function sendJson(res, status, payload) {
  const raw = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  res.end(raw);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16384) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (!total) return {};
  const str = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(str);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "invalid" });
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const out = await store.handleRequest({
      method: req.method || "GET",
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      body,
      origin: `http://${HOST}:${PORT}`,
    });
    return sendJson(res, out.status, out.body);
  }

  // 정적 자산에 인증 헤더나 ?k= 전달 금지(Worker A serveAsset 동일 규칙)
  if (req.headers.authorization || req.headers["x-mailbox-key"] || url.searchParams.has("k")) {
    return sendJson(res, 404, { error: "not_found" });
  }

  // dev 디렉터리 자체 노출 차단
  if (url.pathname === "/dev" || url.pathname.startsWith("/dev/") || url.pathname.includes("/.")) {
    return sendJson(res, 404, { error: "not_found" });
  }

  const isShell =
    url.pathname === "/" ||
    url.pathname === "/app" ||
    /^\/r\/[\w-]+\/?$/.test(url.pathname);
  const relPath = isShell ? "/index.html" : url.pathname;
  const safeFile = path.resolve(PUBLIC_ROOT, "." + relPath);
  if (!safeFile.startsWith(PUBLIC_ROOT)) {
    return sendJson(res, 404, { error: "not_found" });
  }

  try {
    const data = await fs.readFile(safeFile);
    const ext = path.extname(safeFile).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      ...SECURITY_HEADERS,
    });
    res.end(relPath === "/index.html"
      ? data.toString("utf8").replace('name="turnstile-sitekey" content=""', 'name="turnstile-sitekey" content="1x00000000000000000000AA"')
      : data);
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`ARSEN Mailbox v2 local mock server listening on http://${HOST}:${PORT}\n`);
});
