import { subscribe } from "./pool";
import type { Event, SubCloser } from "./pool";

// ── Notification types ───────────────────────────────────────────────────────

export type NotificationType = "mention" | "reaction" | "repost" | "zap";

export interface Notification {
  id: string;
  type: NotificationType;
  event: Event;
  timestamp: number;
  read: boolean;
}

// ── State ────────────────────────────────────────────────────────────────────

const notifications: Notification[] = [];
let notifSub: SubCloser | null = null;
const listeners: Array<(notifs: Notification[]) => void> = [];
const READ_KEY = "reactr_notif_read";

function getLastReadTime(): number {
  return parseInt(localStorage.getItem(READ_KEY) ?? "0", 10);
}

export function markAllRead(): void {
  localStorage.setItem(READ_KEY, String(Math.floor(Date.now() / 1000)));
  for (const n of notifications) n.read = true;
  notify();
}

function notify(): void {
  for (const fn of listeners) fn([...notifications]);
}

export function onNotifications(fn: (notifs: Notification[]) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function getNotifications(): Notification[] {
  return [...notifications];
}

export function getUnreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

// ── Subscription ─────────────────────────────────────────────────────────────

export function startNotificationSubscription(pubkey: string): void {
  stopNotificationSubscription();
  const lastRead = getLastReadTime();
  const since = Math.floor(Date.now() / 1000) - 86400 * 7; // last 7 days

  // Subscribe to mentions (kind-1 with p-tag = us)
  const mentionSub = subscribe(
    { kinds: [1], "#p": [pubkey], since, limit: 100 },
    (event) => {
      if (event.pubkey === pubkey) return; // skip own mentions
      addNotification("mention", event, lastRead);
    },
  );

  // Subscribe to reactions on our notes (kind-7 with p-tag = us)
  const reactionSub = subscribe(
    { kinds: [7], "#p": [pubkey], since, limit: 100 },
    (event) => {
      if (event.pubkey === pubkey) return;
      addNotification("reaction", event, lastRead);
    },
  );

  // Subscribe to reposts (kind-6 with p-tag = us)
  const repostSub = subscribe(
    { kinds: [6], "#p": [pubkey], since, limit: 100 },
    (event) => {
      if (event.pubkey === pubkey) return;
      addNotification("repost", event, lastRead);
    },
  );

  // Subscribe to zap receipts (kind-9735 with p-tag = us)
  const zapSub = subscribe(
    { kinds: [9735], "#p": [pubkey], since, limit: 100 },
    (event) => {
      addNotification("zap", event, lastRead);
    },
  );

  // Composite closer
  notifSub = {
    close: () => {
      mentionSub.close();
      reactionSub.close();
      repostSub.close();
      zapSub.close();
    },
  };
}

export function stopNotificationSubscription(): void {
  if (notifSub) { notifSub.close(); notifSub = null; }
}

function addNotification(type: NotificationType, event: Event, lastReadTime: number): void {
  // Deduplicate
  if (notifications.some((n) => n.id === event.id)) return;

  notifications.push({
    id: event.id,
    type,
    event,
    timestamp: event.created_at,
    read: event.created_at <= lastReadTime,
  });

  // Keep sorted by time, newest first
  notifications.sort((a, b) => b.timestamp - a.timestamp);

  // Cap at 500
  if (notifications.length > 500) notifications.length = 500;

  notify();
}
