import { Refused } from "./policy";

const encoder = new TextEncoder();
const pattern = /^amt_v2_([0-9a-z]{1,10})_([A-Za-z0-9_-]{43})$/;
const encode = (raw: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(raw)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

type TicketScope = { id: string; room_id: string; key_hash: string; key_epoch: number; ticket_generation: number };
const input = (who: TicketScope, stamp: number) =>
  encoder.encode(JSON.stringify(["mailbox:address-send:v2", who.id, who.room_id, who.key_hash, who.key_epoch, who.ticket_generation, stamp]));
const hmac = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function reusableTicket(secret: string, who: TicketScope, now: number) {
  const stamp = Math.floor(now / 60) * 60;
  const mac = await crypto.subtle.sign("HMAC", await hmac(secret), input(who, stamp));
  return "amt_v2_" + stamp.toString(36) + "_" + encode(mac);
}

/** New confirmations are stateless until a successful send advances the participant generation. */
export async function verifyReusableTicket(
  secret: string | undefined, who: TicketScope, value: string, now: number, lifetime: number,
) {
  if (!value.startsWith("amt_v2_")) return false;
  const parts = pattern.exec(value);
  if (!secret?.trim() || !parts) throw new Refused("ticket_invalid");
  const stamp = Number.parseInt(parts[1], 36);
  if (!Number.isSafeInteger(stamp) || stamp > now || stamp <= now - lifetime || stamp % 60 ||
      parts[1] !== stamp.toString(36)) throw new Refused("ticket_invalid");
  const raw = Uint8Array.from(atob(parts[2].replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (encode(raw.buffer) !== parts[2] || !await crypto.subtle.verify("HMAC", await hmac(secret), raw, input(who, stamp))) {
    throw new Refused("ticket_invalid");
  }
  return true;
}
