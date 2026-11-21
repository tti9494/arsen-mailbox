export const BRAND = "아르센 우편함";
export const SPACE_LIMITS = {
  rooms: 5,
  participants: 8,
  messages_per_day: 500,
  message_chars: 2000,
  message_bytes: 4096,
  retention_days: 30,
  assistant_read_seconds: 30,
  signups_per_ip_day: 3,
  d1_writes_per_day: 100_000,
  signup_stop_writes: 60_000,
} as const;
export const MAX_ROOMS = 30;
// 600 regular posts reserve 16,800 points of the default 24,000 space budget.
export const MAX_DAILY_POST_LIMIT = 600;
export const MAX_ROOM_PARTICIPANTS = 50;
