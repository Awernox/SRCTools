/**
 * The presence SRCTools would publish right now.
 *
 * A hook rather than a one-off in the shell because Settings shows the same
 * thing as a preview, and a preview built from different code would eventually
 * stop matching what is actually sent.
 *
 * Everything is selected as a primitive. Returning a freshly built object from
 * a Zustand selector would give `useSyncExternalStore` a new snapshot on every
 * render and loop; the composition happens in `useMemo` instead.
 */

import { useMemo } from 'react';

import { composePresence, type PendingCount } from '../presence';
import { useT } from '../i18n';
import type { DiscordPresence } from '../ipc';
import { useApp } from '../store/app';
import { useDashboard } from '../store/dashboard';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';

export function useLivePresence(): DiscordPresence {
  const t = useT();

  const page = useApp((state) => state.page);
  const fastReview = useApp((state) => state.fastReview);
  const detailRunId = useApp((state) => state.detailRunId);
  const gameId = useApp((state) => state.gameId);

  const showPage = useSession((state) => state.settings.discordShowPage);
  const showPending = useSession((state) => state.settings.discordShowPending);
  const showGame = useSession((state) => state.settings.discordShowGame);
  const showModerator = useSession((state) => state.settings.discordShowModerator);
  const moderator = useSession((state) => state.profile?.displayName ?? null);

  // The run on screen names the game better than the page does: a moderator
  // with a run open is looking at that game whatever page they came from.
  const runGame = useQueue((state) =>
    detailRunId === null
      ? null
      : (state.runs.find((run) => run.id === detailRunId)?.gameName ?? null),
  );
  const libraryGame = useSession((state) =>
    gameId === null ? null : (state.games.find((game) => game.id === gameId)?.name ?? null),
  );

  // Prefer the queue's own count: it is what the moderator is looking at, and
  // it drops as runs are handled. The dashboard's figure is the fallback for
  // before the queue has been fetched, and both carry their "there are more"
  // flag rather than presenting a page as the whole backlog.
  const queueCounts = useQueue((state) =>
    state.fetchedAt !== null && state.filter.status === 'new' ? state.runs.length : -1,
  );
  const queueTruncated = useQueue((state) => state.truncated);
  const dashboardCount = useDashboard((state) => state.summary?.pendingCount ?? -1);
  const dashboardPartial = useDashboard((state) => state.summary?.pendingIsPartial ?? false);

  return useMemo(() => {
    let pending: PendingCount | null = null;
    if (queueCounts >= 0) pending = { count: queueCounts, partial: queueTruncated };
    else if (dashboardCount >= 0) {
      pending = { count: dashboardCount, partial: dashboardPartial };
    }

    return composePresence(
      {
        page,
        fastReview,
        game: runGame ?? libraryGame,
        pending,
        moderator,
        show: {
          page: showPage,
          pending: showPending,
          game: showGame,
          moderator: showModerator,
        },
      },
      t,
    );
  }, [
    t,
    page,
    fastReview,
    runGame,
    libraryGame,
    queueCounts,
    queueTruncated,
    dashboardCount,
    dashboardPartial,
    moderator,
    showPage,
    showPending,
    showGame,
    showModerator,
  ]);
}
