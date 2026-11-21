// Local CLI helpers. The D1 binding is pinned to the dummy database in the loopback config.
import { createHash, randomBytes } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = (bytes) => randomBytes(bytes).toString("base64url");
export function localDB(state) {
  if (!state || !isAbsolute(state)) throw Error("absolute local state required");
  return getPlatformProxy({
    configPath: fileURLToPath(new URL("./wrangler.local.jsonc", import.meta.url)),
    envFiles: [],
    persist: { path: resolve(state, "v3") },
    remoteBindings: false,
  });
}
export async function privateWrite(output, data) {
  if (!output || !isAbsolute(output)) throw Error("absolute output required");
  const dir = await realpath(dirname(output));
  const outside = relative(fileURLToPath(new URL("../", import.meta.url)), dir);
  if (!(outside === ".." || outside.startsWith("../")) || (await stat(dir)).mode & 0o077)
    throw Error("private directory required");
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
    await file.sync();
  } finally {
    await file.close();
  }
}
