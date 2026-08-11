/**
 * Ctrl+K command palette: jump to a page, a game, a run, or fire a command.
 *
 * The list is rebuilt from the store snapshots each time it opens, so nothing
 * here needs a subscription — typing only filters what is already loaded, which
 * is the same rule the queue filter box follows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Gamepad2,
  LayoutDashboard,
  ListChecks,
  RefreshCw,
  Search,
  Settings,
  Star,
  Timer,
  Video,
} from 'lucide-react';

import { APP_NAME, BRAND_MARK } from './Brand';
import { useApp, type PageId } from '../store/app';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import { useDashboard } from '../store/dashboard';
import { useHistory } from '../store/history';

interface PaletteItem {
  id: string;
  title: string;
  sub?: string;
  icon: React.ReactNode;
  run: () => void;
}

const PAGE_ICONS: Record<PageId, React.ReactNode> = {
  dashboard: <LayoutDashboard size={15} />,
  queue: <ListChecks size={15} />,
  games: <Gamepad2 size={15} />,
  history: <Timer size={15} />,
  stats: <Star size={15} />,
  settings: <Settings size={15} />,
};

const PAGE_DESC: Record<PageId, string> = {
  dashboard: 'What is waiting for you today',
  queue: 'Runs to review',
  games: 'Your moderated games',
  history: 'Actions taken from this machine',
  stats: 'Your moderation numbers',
  settings: 'Appearance, keys, credentials',
};

export function CommandPalette() {
  const open = useApp((state) => state.paletteOpen);
  const close = useApp((state) => state.togglePalette);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // The palette input owns the keyboard while it is open; focus it so the
    // user can type without a click.
    input.current?.focus();
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    const { go, openGame, openDetail } = useApp.getState();
    const session = useSession.getState();
    const queue = useQueue.getState();
    const needle = query.trim().toLowerCase();

    const match = (text: string | null | undefined) =>
      !needle || (text ?? '').toLowerCase().includes(needle);

    const built: PaletteItem[] = [
      {
        id: 'page:dashboard',
        title: 'Dashboard',
        sub: PAGE_DESC.dashboard,
        icon: PAGE_ICONS.dashboard,
        run: () => {
          close(false);
          go('dashboard');
        },
      },
      {
        id: 'page:queue',
        title: 'Review queue',
        sub: PAGE_DESC.queue,
        icon: PAGE_ICONS.queue,
        run: () => {
          close(false);
          go('queue');
        },
      },
      {
        id: 'page:games',
        title: 'Games',
        sub: PAGE_DESC.games,
        icon: PAGE_ICONS.games,
        run: () => {
          close(false);
          go('games');
        },
      },
      {
        id: 'page:history',
        title: 'History',
        sub: PAGE_DESC.history,
        icon: PAGE_ICONS.history,
        run: () => {
          close(false);
          go('history');
        },
      },
      {
        id: 'page:stats',
        title: 'Statistics',
        sub: PAGE_DESC.stats,
        icon: PAGE_ICONS.stats,
        run: () => {
          close(false);
          go('stats');
        },
      },
      {
        id: 'page:settings',
        title: 'Settings',
        sub: PAGE_DESC.settings,
        icon: PAGE_ICONS.settings,
        run: () => {
          close(false);
          go('settings');
        },
      },
      {
        id: 'cmd:refresh',
        title: 'Refresh current view',
        sub: 'Reload from Speedrun.com',
        icon: <RefreshCw size={15} />,
        run: () => {
          close(false);
          const page = useApp.getState().page;
          if (page === 'queue') void queue.load(true);
          else if (page === 'dashboard') void useDashboard.getState().load(true);
          else if (page === 'history') void useHistory.getState().load();
          else if (page === 'games') void useSession.getState().refreshGames();
        },
      },
      {
        id: 'cmd:checkvideos',
        title: 'Check videos in the queue',
        sub: queue.runs.length > 0 ? `${queue.runs.length} runs loaded` : 'Nothing loaded yet',
        icon: <Video size={15} />,
        run: () => {
          close(false);
          go('queue');
          void queue.checkVideos(true);
        },
      },
    ];

    // Games the moderator owns — this is the "search games" half of the bar.
    for (const game of session.games.slice(0, 30)) {
      if (!match(game.name) && !match(game.abbreviation)) continue;
      built.push({
        id: `game:${game.id}`,
        title: game.name,
        sub: game.abbreviation ?? 'Game',
        icon: <Gamepad2 size={15} />,
        run: () => {
          close(false);
          openGame(game.id);
        },
      });
    }

    // Runs currently in the queue, capped so the list stays scannable.
    for (const run of queue.visible().slice(0, 12)) {
      if (!match(run.playerLabel) && !match(run.categoryName) && !match(run.gameName)) continue;
      built.push({
        id: `run:${run.id}`,
        title: run.playerLabel,
        sub: `${run.gameName} · ${run.categoryName ?? ''}`.replace(/ · $/, ''),
        icon: <ArrowRight size={15} />,
        run: () => {
          close(false);
          go('queue');
          openDetail(run.id);
        },
      });
    }

    return built;
    // The store actions are stable references; rebuilding per keystroke is fine.
  }, [open, query]);

  if (!open) return null;

  const visible = items;
  const closePalette = () => close(false);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (visible.length === 0 ? 0 : (index + 1) % visible.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (visible.length === 0 ? 0 : (index - 1 + visible.length) % visible.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = visible[active];
      if (item) item.run();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePalette();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={closePalette}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
          <Search size={16} style={{ color: 'var(--text-tertiary)', marginRight: 10, flexShrink: 0 }} />
          <input
            ref={input}
            className="palette__input"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a page, game or run…"
            aria-label="Command palette search"
          />
          <img
            src={BRAND_MARK}
            alt=""
            width={18}
            height={18}
            style={{ borderRadius: 4, flexShrink: 0, marginLeft: 10 }}
          />
        </div>
        <div className="palette__list" role="listbox">
          {visible.length === 0 && (
            <div style={{ padding: '18px 12px', textAlign: 'center' }}>
              <span className="dim">No matches for “{query}”.</span>
            </div>
          )}
          {visible.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              className="palette__item"
              onMouseEnter={() => setActive(index)}
              onClick={item.run}
            >
              {item.icon}
              <span className="palette__item-title">{item.title}</span>
              {item.sub && <span className="palette__item-sub">{item.sub}</span>}
            </button>
          ))}
        </div>
        <div className="palette__footer">
          <span className="kbd-row">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>
            <span>navigate</span>
          </span>
          <span className="kbd-row">
            <kbd className="kbd">Enter</kbd>
            <span>open</span>
          </span>
          <span style={{ flex: 1 }} />
          <span>
            {APP_NAME} · Ctrl+K to toggle
          </span>
        </div>
      </div>
    </div>
  );
}
