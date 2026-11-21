// Run from the repository root with a path in a private temporary directory.
// The HTTP server is the real Worker and D1 under workerd. Only Siteverify is replaced.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";

const fixture = process.argv[2];
assert.ok(fixture, "provide a private fixture file path");
const { vars, assets, compatibility_date } = unstable_readConfig({ config: "src/wrangler.local.jsonc" });
const bundle = await build({
  entryPoints: ["src/index.ts"], bundle: true, format: "esm", write: false,
});
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: compatibility_date,
  host: "127.0.0.1",
  port: 0,
  logRequests: false,
  unsafeRegisterWorker: false,
  bindings: process.argv.includes("--images") ? { ...vars, IMAGE_UPLOADS: "on" } : vars,
  d1Databases: ["DB"],
  assets: {
    directory: resolve("src", assets.directory),
    binding: assets.binding,
    run_worker_first: assets.run_worker_first,
    routerConfig: { has_user_worker: true },
    assetConfig: { html_handling: assets.html_handling },
  },
  outboundService: async (request) => {
    if (request.url !== "https://challenges.cloudflare.com/turnstile/v0/siteverify" || request.method !== "POST")
      return new Response(null, { status: 502 });
    const form = new URLSearchParams(await request.text());
    return Response.json({
      success: form.get("secret") === vars.TURNSTILE_SECRET &&
        form.get("response") === "XXXX.DUMMY.TOKEN.XXXX",
    });
  },
}));

let published = false;
try {
  const db = await runtime.getD1Database("DB");
  const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(resolve("migrations", file), "utf8");
    await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
  }
  const invite = "ami_" + randomBytes(24).toString("base64url");
  await db.prepare(
    "INSERT INTO invite_codes(code_hash,created_at,max_uses,expires_at) VALUES(?,unixepoch(),2,unixepoch()+3600)",
  ).bind(createHash("sha256").update(invite).digest("hex")).run();
  const base = (await runtime.ready).origin;
  await writeFile(fixture, JSON.stringify({ base, invite }), { mode: 0o600, flag: "wx" });
  published = true;
  console.log("Local Worker and isolated D1 ready");
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
} finally {
  await runtime.dispose();
  if (published) await unlink(fixture);
}
