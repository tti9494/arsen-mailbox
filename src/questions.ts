import { Refused, SENSITIVE } from "./policy";
import { MAX_ROOM_PARTICIPANTS } from "./brand";

type Member = { id: string; name: string; ai_type: string | null };
export type QuestionTarget = { id: string; step: number | null; direct: boolean };
const ALL_ADDRESSES = ["전체", "다들", "모두", "전원"];
const SHORT_ALL_ADDRESSES = ["비서들", "출첵"];

const TYPE_NAMES: Record<string, string[]> = {
  claude: ["클로드"],
  chatgpt: ["챗GPT"],
  gemini: ["제미나이"],
  pickle: ["피클"],
  vooy: ["부이", "브이"],
  hark: ["하크"],
  cue: ["큐"],
  keyring: ["키링"],
  instinct: ["인스팅트"],
  muse: ["뮤즈"],
};

const normalize = (s: string) => s.normalize("NFC").toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function addName(index: Map<string, Member[]>, label: string, member: Member) {
  if (!label) return;
  const k = normalize(label);
  const existing = index.get(k) ?? [];
  if (!existing.some((candidate) => candidate.id === member.id)) index.set(k, [...existing, member]);
}

/** Leading addresses own the clause, so "부이, 피클 답을 비교" does not ask Pickle again. */
export function routeQuestion(text: string, members: Member[]): QuestionTarget[] {
  if (!members.length) return [];
  const names = new Map<string, Member[]>();
  const aliases = new Map<string, Member[]>();
  for (const member of members) {
    addName(names, member.name, member);
    addName(aliases, member.name.replace(/[0-9]+$/, "").trim(), member);
    if (member.ai_type) {
      for (const label of [member.ai_type, ...(TYPE_NAMES[member.ai_type] ?? [])]) addName(aliases, label, member);
    }
  }
  const shortAll = new Set(SHORT_ALL_ADDRESSES.filter((label) => !names.has(label) && !aliases.has(label)));
  const allAddresses = new Set([...ALL_ADDRESSES, ...shortAll]);
  const labels = [...new Set([...names.keys(), ...aliases.keys(), ...allAddresses])]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const token = `@?(${labels.join("|")})(님(?:에게|한테|께)?|에게|한테|께|아|야|이랑|하고|와|과|랑|도)?(?![\\p{L}\\p{N}_])`;
  const prefix = new RegExp(`^\\s*${token}`, "iu");
  const matchAddress = (clause: string, first = false) => {
    const match = prefix.exec(clause);
    if (!match || !shortAll.has(match[1]) || match[0].trimStart().startsWith("@")) return match;
    // Bare short calls belong at the start, where they cannot turn "부이, 출첵" into a broadcast.
    const rest = clause.slice(match[0].length);
    return first && !match[2] && (/^\s*(?:[,，:：]|→|->|[.!?。！？]*$)/u.test(rest) ||
      (match[1] === "비서들" && /^\s+출첵[.!?。！？]*$/u.test(rest))) ? match : null;
  };
  const first = matchAddress(text, true);
  let terms: string[] = [];
  let ordered = false;
  if (first) {
    terms = [first[1]];
    let particle = first[2];
    let rest = text.slice(first[0].length);
    while (rest) {
      const separator = /^\s*(→|->|[,，])\s*/u.exec(rest);
      const remaining = separator ? rest.slice(separator[0].length) : rest;
      const next = matchAddress(remaining);
      if (!next || (!separator && !rest.trimStart().startsWith("@") && !/^(?:이랑|하고|와|과|랑)$/u.test(particle ?? ""))) {
        if (separator && /→|->/.test(separator[1])) throw new Refused("question_ambiguous");
        break;
      }
      const following = remaining.slice(next[0].length);
      const arrow = Boolean(separator && /→|->/.test(separator[1]));
      // A bare name after a comma may be referenced prose. A delimiter or explicit @ ends the address.
      if (separator && !arrow && !remaining.trimStart().startsWith("@") && following.trim() &&
          !/^\s*(?:[,，:：]|→|->)/u.test(following) &&
          !/^(?:이랑|하고|와|과|랑)$/u.test(next[2] ?? "")) break;
      ordered ||= arrow;
      terms.push(next[1]);
      particle = next[2];
      rest = following;
    }
  } else {
    if (/^\s*@/u.test(text)) throw new Refused("question_ambiguous");
    const matches = text.matchAll(new RegExp(`(?:^|[^\\p{L}\\p{N}_])${token}`, "giu"));
    terms = [...matches].filter((match) => !allAddresses.has(normalize(match[1])) || match[0].includes("@"))
      .map((match) => match[1]);
  }
  if (terms.some((term) => allAddresses.has(normalize(term)))) {
    if (ordered) throw new Refused("question_ambiguous");
    return members.map(({ id }) => ({ id, step: null, direct: false }));
  }
  const ids = new Set<string>();
  for (const term of terms) {
    const k = normalize(term);
    const exact = names.get(k);
    const group = exact?.find((m) => m.name === term);
    const candidates = group ? [group] : (exact ?? aliases.get(k) ?? []);
    if (candidates.length > 1) throw new Refused("question_ambiguous");
    if (candidates.length) ids.add(candidates[0].id);
  }
  return [...ids].map((id, i) => ({
    id,
    direct: true,
    step: ordered && ids.size > 1 ? i + 1 : null,
  }));
}

export type QuestionState = {
  question_id: number;
  participant_id: string;
  participant_name: string;
  step: number | null;
  asked_at: number;
  reply_id: number | null;
  answered_at: number | null;
  awaiting_previous: number;
  direct: number;
};

export type RelayTurn = {
  question_id: number;
  preceding_reply_id: number;
  question: string;
  preceding_reply: string;
};

const AFFECTED_IDS = "SELECT value AS id FROM json_each(?1) UNION " +
  "SELECT t.question_id FROM json_each(?1) ids CROSS JOIN question_targets t ON t.reply_id=ids.value";

type QuestionRoot = { id: number; asked_at: number; route: string | null };
type TargetRow = Omit<QuestionState, "asked_at" | "awaiting_previous" | "direct"> & { recorded_reply_id: number | null };

export async function questionContext(db: D1Database, roomId: string, messageIds: number[], cutoff: number) {
  const page = new Set(messageIds);
  const roots = await db.prepare("WITH relevant AS MATERIALIZED (" + AFFECTED_IDS + ")" +
    " SELECT q.id,q.created_at AS asked_at,q.question_route AS route FROM relevant ids" +
    " CROSS JOIN messages q ON q.id=ids.id WHERE q.room_id=?2 AND q.created_at>?3" +
    " AND (q.question_route IS NOT NULL OR EXISTS(SELECT 1 FROM question_targets t WHERE t.question_id=q.id))",
  ).bind(JSON.stringify(messageIds), roomId, cutoff).all<QuestionRoot>();
  const byId = new Map(roots.results.map((q) => [q.id, { ...q, targets: q.route ? JSON.parse(q.route) as QuestionTarget[] : null }]));
  // Each target can require its own row and its participant and reply lookups.
  const rows = roots.meta.rows_read + [...byId.values()].reduce((n, q) => n + 3 + 5 * (q.targets?.length ?? MAX_ROOM_PARTICIPANTS), 0);
  return { page, byId, rows };
}

export function questionStates(db: D1Database, roomId: string, questionIds: number[], cutoff: number) {
  return db.prepare(
    "SELECT t.question_id,t.participant_id,p.name AS participant_name,t.step," +
      " t.reply_id AS recorded_reply_id,a.id AS reply_id,a.created_at AS answered_at" +
      " FROM json_each(?1) ids CROSS JOIN question_targets t ON t.question_id=ids.value" +
      " CROSS JOIN participants p ON p.id=t.participant_id" +
      " LEFT JOIN messages a ON a.id=t.reply_id AND a.room_id=?2 AND a.created_at>?3" +
      " ORDER BY t.question_id,t.step,p.created_at,p.rowid",
  ).bind(JSON.stringify(questionIds), roomId, cutoff);
}

export function decorateQuestionStates(rows: unknown[], context: Awaited<ReturnType<typeof questionContext>>) {
  const pending = new Set<number>();
  const directByQuestion = new Map([...context.byId].map(([id, q]) =>
    [id, new Set(q.targets?.filter((t) => t.direct).map((t) => t.id))]));
  const questions: QuestionState[] = [];
  for (const { recorded_reply_id, ...row } of rows as TargetRow[]) {
    const awaiting = row.step !== null && row.step > 0 && pending.has(row.question_id);
    if (row.step !== null && recorded_reply_id === null) pending.add(row.question_id);
    if (context.page.has(row.question_id) || (recorded_reply_id !== null && context.page.has(recorded_reply_id))) {
      questions.push({ ...row, asked_at: context.byId.get(row.question_id)!.asked_at,
        awaiting_previous: awaiting ? 1 : 0, direct: directByQuestion.get(row.question_id)!.has(row.participant_id) ? 1 : 0 });
    }
  }
  return questions;
}

export const RELAY_ROWS = 80;
const READY_RELAYS = " FROM question_targets INDEXED BY question_targets_ready" +
  " WHERE participant_id=?1 AND reply_id IS NULL AND preceding_reply_id IS NOT NULL";

export function hasRelay(db: D1Database, participantId: string) {
  return db.prepare("SELECT 1" + READY_RELAYS + " LIMIT 1").bind(participantId);
}

export function relayTurns(db: D1Database, roomId: string, participantId: string, cutoff: number) {
  return db.prepare(
    "WITH ready AS MATERIALIZED (SELECT question_id,preceding_reply_id" + READY_RELAYS +
      " ORDER BY question_id DESC LIMIT 20)" +
      " SELECT q.id AS question_id,a.id AS preceding_reply_id,q.body AS question,a.body AS preceding_reply" +
      " FROM ready t JOIN messages q ON q.id=t.question_id" +
      " JOIN messages a ON a.id=t.preceding_reply_id AND a.room_id=q.room_id" +
      " WHERE q.room_id=?2 AND q.created_at>?3 AND a.created_at>?3 ORDER BY q.id",
  ).bind(participantId, roomId, cutoff);
}

export function safeExcerpt(text: string, limit = 800): string {
  return SENSITIVE.test(text) ? "[민감 의심 내용 제외]" : [...text].slice(0, limit).join("");
}
