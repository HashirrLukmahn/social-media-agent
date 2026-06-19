// Builds today's posting schedule: 3 slots, each at a random time inside
// its posting window. Schedule is stable for the day — does not change
// mid-day even if this process restarts.

import { v4 as uuidv4 } from "uuid";
import { POSTING_WINDOWS } from "../../shared/constants.js";
import type { PostingSlot } from "../../shared/types.js";

function randomTimeInWindow(
  openH: number,
  openM: number,
  closeH: number,
  closeM: number,
  baseDate: Date
): Date {
  // Handle windows that span midnight UTC (window 3: 23:00 – 00:30 next day).
  const openMs = (openH * 60 + openM) * 60_000;
  let closeMs = (closeH * 60 + closeM) * 60_000;
  if (closeMs <= openMs) closeMs += 24 * 60 * 60_000; // next day

  const windowMs = closeMs - openMs;
  const offsetMs = Math.floor(Math.random() * windowMs);

  const dayStartUtc = new Date(
    Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate())
  );
  return new Date(dayStartUtc.getTime() + openMs + offsetMs);
}

export function buildTodaySchedule(correlationIdPrefix?: string): PostingSlot[] {
  const today = new Date();
  return POSTING_WINDOWS.map((w, i) => {
    const scheduledAt = randomTimeInWindow(w.openH, w.openM, w.closeH, w.closeM, today);
    const windowIndex = i as 0 | 1 | 2;
    const dateStr = today.toISOString().slice(0, 10);
    const slotId = `${dateStr}:w${windowIndex}`;
    return {
      slotId,
      windowIndex,
      scheduledAt,
      correlationId: correlationIdPrefix ? `${correlationIdPrefix}:${slotId}` : uuidv4(),
    };
  });
}

export function msUntil(target: Date): number {
  return Math.max(0, target.getTime() - Date.now());
}

export function msUntilPrePing(slot: PostingSlot, prePingMs = 5 * 60_000): number {
  return Math.max(0, slot.scheduledAt.getTime() - prePingMs - Date.now());
}
