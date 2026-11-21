export const MAX_SEND_CHUNKS: number;
export type SendChunk = { text: string; rest: string };
export function splitMessageText(raw: unknown): SendChunk[];
export function splitProblem(raw: unknown): "" | "too_many";
