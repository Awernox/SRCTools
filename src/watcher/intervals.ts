/**
 * Poll cadence.
 *
 * The intervals a moderator can choose, and nothing else. There used to be an
 * adaptive layer here — a ×4 multiplier while the window was unfocused, and a
 * backoff reaching ten minutes — and both were removed rather than tuned. The
 * multiplier applied exactly when it hurt most (a moderator waiting for a toast
 * is, by definition, not looking at the window), and the backoff turned three
 * transient network errors into a watcher that appeared to have stopped until
 * the app was restarted.
 *
 * A fixed list rather than a free number: the shortest interval the moderator
 * can pick still has to be one Speedrun.com will serve, and an arbitrary "0.2s"
 * typed into a box would spend the whole rate-limit budget on polling and leave
 * nothing for moderating.
 *
 * The loop itself is in Rust and paces itself from the chosen value. What
 * failure handling remains lives there, is bounded to thirty seconds, and
 * recovers without a restart.
 */

/** Seconds. Offered in Settings in exactly this order. */
export const CHECK_INTERVALS = [1, 3, 5, 10, 30, 60, 300] as const;

export type CheckInterval = (typeof CHECK_INTERVALS)[number];

export const DEFAULT_CHECK_INTERVAL: CheckInterval = 5;

export function isCheckInterval(value: unknown): value is CheckInterval {
  return (
    typeof value === 'number' && (CHECK_INTERVALS as readonly number[]).includes(value)
  );
}

/** Consecutive failures before the watcher reports the API as down. */
export const FAILURES_BEFORE_ALERT = 3;
