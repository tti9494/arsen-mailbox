import { Refused, SENSITIVE } from "./policy";
import { historyScan, historyWindow } from "./retention";
import { attachImageSummary, IMAGE_SUMMARY_SQL } from "./images";

type ExportRow = {
  id: number;
  created_at: number;
  sender: string;
  body: string;
  relayed_for: string | null;
  reply_to: number | null;
  response_seconds: number | null;
  image?: { mime: string; bytes: number; width: number; height: number; sha256: string };
};

export const EXPORT_READ_COST = 18;
const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString();
const redact = (value: string) => SENSITIVE.test(value) ? "[민감 의심 내용 제외]" : value;

function csvCell(value: string | number | null) {
  let text = typeof value === "string" ? redact(value) : value === null ? "" : String(value);
  // CSV quotes do not stop spreadsheets from evaluating a formula.
  if (/^(?:[\t\r\n]|\s*[=+\-@＝＋－＠])/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function formatRows(rows: ExportRow[], format: "md" | "csv" | "txt" | "json", first: boolean) {
  if (format === "json") return rows.map((r) => JSON.stringify({
    id: r.id, created_at_utc: timestamp(r.created_at), sender: redact(r.sender),
    relayed: Boolean(r.relayed_for), reply_to: r.reply_to, response_seconds: r.response_seconds,
    text: redact(r.body),
    ...(r.image ? { image: r.image } : {}),
  })).join(",\n");
  if (format === "csv") {
    const cols = ["id", "created_at_utc", "sender", "relayed", "reply_to", "response_seconds", "text", "image_mime", "image_bytes", "image_width", "image_height", "image_sha256"];
    return [
      ...(first ? [cols.join(",")] : []),
      ...rows.map((r) =>
        [r.id, timestamp(r.created_at), r.sender, r.relayed_for ? "yes" : "no", r.reply_to, r.response_seconds, r.body,
          r.image?.mime ?? null, r.image?.bytes ?? null, r.image?.width ?? null, r.image?.height ?? null, r.image?.sha256 ?? null]
          .map(csvCell).join(",")),
    ].map((line) => line + "\r\n").join("");
  }
  if (format === "txt") {
    return rows.map((r) => [
      `[${timestamp(r.created_at)}] #${r.id} ${redact(r.sender)}${r.relayed_for ? " (사용자가 대신 올림)" : ""}`,
      ...(r.reply_to === null ? [] : [`답장: #${r.reply_to}`]),
      ...(r.response_seconds === null ? [] : [`응답 소요: ${r.response_seconds}초`]),
      ...(r.image ? [imageDescription(r.image)] : []),
      redact(r.body),
      "",
    ].join("\n") + "\n").join("");
  }
  return (first ? "# 우편함 대화 (UTC)\n\n" : "") + rows.map((r) => {
    const meta = [`보낸 사람: ${redact(r.sender)}`, `글 번호: ${r.id}`];
    if (r.relayed_for) meta.push("사용자가 대신 올림");
    if (r.image) meta.push(imageDescription(r.image));
    if (r.reply_to !== null) meta.push(`답장: #${r.reply_to}`);
    if (r.response_seconds !== null) meta.push(`응답 소요: ${r.response_seconds}초`);
    return `## ${timestamp(r.created_at)}\n\n` +
      [meta.join(" · "), ...redact(r.body).split(/\r?\n/)].map((line) => "    " + line + "\n").join("") + "\n";
  }).join("");
}

function imageDescription(image: NonNullable<ExportRow["image"]>) {
  return `이미지 ${image.mime} · ${image.bytes}바이트 · ${image.width}×${image.height} · SHA-256 ${image.sha256}`;
}

export async function exportPage(
  db: D1Database, guards: D1PreparedStatement[], room: string, url: URL, cutoff: number, since: number, policy: string, now: number,
) {
  const format = url.searchParams.get("format");
  if (format !== "md" && format !== "csv" && format !== "txt" && format !== "json") throw new Refused("invalid");
  const rawUntil = url.searchParams.get("until");
  if (rawUntil !== null && !/^\d{1,15}$/.test(rawUntil)) throw new Refused("invalid");
  if (rawUntil !== null && url.searchParams.get("policy") !== policy) throw new Refused("policy_changed");
  const until = rawUntil === null ? null : Number(rawUntil);
  const results = await db.batch([
    ...guards,
    db.prepare(
      "WITH boundary AS MATERIALIZED (SELECT COALESCE(?3,(SELECT MAX(id) FROM messages WHERE room_id=?1),0) AS last_id)," +
        historyScan("?1", "?4", "?2", "?5", "(SELECT last_id FROM boundary)") +
        " SELECT last_id,scanned_count,scan_end,m.id,m.created_at,COALESCE(a.name,p.name) AS sender,m.body,m.relayed_for,m.reply_to,i.sha256 AS image_sha256," + IMAGE_SUMMARY_SQL + "," +
        " CASE WHEN q.id IS NOT NULL THEN m.created_at-q.created_at END AS response_seconds" +
        " FROM boundary,scanned_range LEFT JOIN retained h ON 1 LEFT JOIN messages m ON m.id=h.id" +
        " LEFT JOIN message_images i ON i.message_id=m.id" +
        " LEFT JOIN participants p ON p.id=m.participant_id" +
        " LEFT JOIN participants a ON a.id=m.relayed_for LEFT JOIN question_targets t ON t.reply_id=m.id" +
        " LEFT JOIN messages q ON q.id=t.question_id AND q.room_id=m.room_id AND q.created_at>?2" +
        " ORDER BY m.id",
    ).bind(room, cutoff, until, since, now),
  ]);
  const rows = results.at(-1)!.results as (ExportRow & Parameters<typeof attachImageSummary>[0] & { image_sha256: string | null; last_id: number; scanned_count: number; scan_end: number })[];
  const { last_id, scanned_count, scan_end } = rows[0];
  const { page: selected, more, next } = historyWindow(rows.filter(({ id }) => id !== null), scanned_count, scan_end, since);
  const page = selected.map(({ image_sha256, last_id: _last, scanned_count: _count, scan_end: _end, ...raw }) => {
    const { image, ...row } = attachImageSummary(raw);
    return { ...row, ...(image ? { image: { ...image, sha256: image_sha256! } } : {}) };
  });
  return {
    chunk: formatRows(page, format, since === 0),
    next, until: more || until !== null ? last_id : (page.at(-1)?.id ?? 0), more, policy,
  };
}
