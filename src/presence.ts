/**
 * What Discord shows about the current session.
 *
 * Kept as one pure function so the rules are visible in one place and the shell
 * only has to feed it state. Discord renders exactly two lines under the app
 * name, so everything the moderator asked to include has to fit in those: the
 * page (plus Fast Review) on the first, and the game, the pending count and the
 * moderator on the second.
 *
 * Nothing here is guessed. A pending count the app does not actually have is
 * left out rather than shown as zero, and a partial count is marked as such.
 */

import type { DiscordPresence } from './ipc';
import type { Translate } from './i18n';
import type { PageId } from './store/app';

/** Translation key for each page's presence line. */
const PAGE_KEY: Record<PageId, Parameters<Translate>[0]> = {
  dashboard: 'discord.page.dashboard',
  queue: 'discord.page.queue',
  games: 'discord.page.games',
  history: 'discord.page.history',
  stats: 'discord.page.stats',
  settings: 'discord.page.settings',
};

/** How many pending runs SRCTools knows about, and whether that is all of them. */
export interface PendingCount {
  count: number;
  /** True when the number is a floor — more exist than were fetched. */
  partial: boolean;
}

export interface PresenceInput {
  page: PageId;
  fastReview: boolean;
  /** The game being looked at, when there is one. */
  game: string | null;
  pending: PendingCount | null;
  /** The signed-in moderator's display name. */
  moderator: string | null;
  show: {
    page: boolean;
    pending: boolean;
    game: boolean;
    moderator: boolean;
  };
}

export function composePresence(input: PresenceInput, t: Translate): DiscordPresence {
  const { show } = input;

  let details: string | null = null;
  if (show.page) {
    const page = t(PAGE_KEY[input.page]);
    details = input.fastReview ? t('discord.presence.fastReview', { page }) : page;
  }

  const parts: string[] = [];
  if (show.game && input.game) {
    parts.push(t('discord.presence.reviewing', { game: input.game }));
  }
  if (show.pending && input.pending) {
    const { count, partial } = input.pending;
    parts.push(
      partial
        ? t('discord.presence.pendingMore', { count })
        : count === 1
          ? t('discord.presence.pendingOne')
          : t('discord.presence.pending', { count }),
    );
  }
  if (show.moderator && input.moderator) {
    parts.push(t('discord.presence.moderator', { name: input.moderator }));
  }

  return { details, state: parts.length > 0 ? parts.join(' · ') : null };
}
