/**
 * Page switch.
 *
 * Deliberately not lazy-loaded: the whole bundle is a few hundred kilobytes and
 * lives on the moderator's disk, so a suspense boundary would only add a flash
 * of nothing between pages that should feel instant.
 */

import { Dashboard } from './Dashboard';
import { FastReview } from './FastReview';
import { Games } from './Games';
import { History } from './History';
import { Queue } from './Queue';
import { Settings } from './Settings';
import { Stats } from './Stats';
import type { PageId } from '../store/app';

export function Pages({
  page,
  gameId,
  fastReview,
}: {
  page: PageId;
  gameId: string | null;
  fastReview: boolean;
}) {
  switch (page) {
    case 'dashboard':
      return <Dashboard />;
    case 'queue':
      // Fast Review is a mode of the queue rather than a page of its own: it
      // works from the same loaded runs and the same selection.
      return fastReview ? <FastReview /> : <Queue />;
    case 'games':
      return <Games gameId={gameId} />;
    case 'history':
      return <History />;
    case 'stats':
      return <Stats />;
    case 'settings':
      return <Settings />;
  }
}
