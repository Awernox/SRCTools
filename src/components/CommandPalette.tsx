/**
 * Ctrl+K command palette: jump to a page, a game, a run, or fire a command.
 *
 * The list is rebuilt from the store snapshots each time it opens, so nothing
 * here needs a subscription — typing only filters what is already loaded, which
 * is the same rule the queue filter box follows.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { plural } from '../format';
import { useT, type TranslationKey } from '../i18n';
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

/**
 * The six pages, in the order the palette lists them.
 *
 * One table rather than six near-identical entries built inline, and it carries
 * catalogue keys rather than English: the title is the same string the sidebar
 * uses, so a page is never called two different things.
 */
const PAGES: Array<{
  id: PageId;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  icon: ReactNode;
}> = [
  {
    id: 'dashboard',
    titleKey: 'nav.dashboard',
    descKey: 'palette.desc.dashboard',
    icon: <LayoutDashboard size={15} />,
  },
  {
    id: 'queue',
    titleKey: 'nav.queue',
    descKey: 'palette.desc.queue',
    icon: <ListChecks size={15} />,
  },
  {
    id: 'games',
    titleKey: 'nav.games',
    descKey: 'palette.desc.games',
    icon: <Gamepad2 size={15} />,
  },
  {
    id: 'history',
    titleKey: 'nav.history',
    descKey: 'palette.desc.history',
    icon: <Timer size={15} />,
  },
  {
    id: 'stats',
    titleKey: 'nav.stats',
    descKey: 'palette.desc.stats',
    icon: <Star size={15} />,
  },
  {
    id: 'settings',
    titleKey: 'nav.settings',
    descKey: 'palette.desc.settings',
    icon: <Settings size={15} />,
  },
];

/**
 * "Half-Life · Any%" for a queued run.
 *
 * Skips whichever half Speedrun.com did not return, so a run with no game name
 * does not read as a separator with nothing on one side of it.
 */
function runSubtitle(gameName: string | null, categoryName: string | null): string {
  return [gameName, categoryName].filter((part): part is string => part !== null).join(' · ');
}

export function CommandPalette() {
  const t = useT();
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
      ...PAGES.map((page) => ({
        id: `page:${page.id}`,
        title: t(page.titleKey),
        sub: t(page.descKey),
        icon: page.icon,
        run: () => {
          close(false);
          go(page.id);
        },
      })),
      {
        id: 'cmd:refresh',
        title: t('palette.refresh'),
        sub: t('palette.refreshSub'),
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
        title: t('palette.checkVideos'),
        sub:
          queue.runs.length > 0
            ? t('palette.runsLoaded', { runs: plural(queue.runs.length, 'run') })
            : t('palette.nothingLoaded'),
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
        sub: game.abbreviation ?? t('palette.gameFallback'),
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
        sub: runSubtitle(run.gameName, run.categoryName),
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
  }, [open, query, t]);

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
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.searchAria')}
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
              <span className="dim">{t('palette.noMatches', { query })}</span>
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
            <span>{t('palette.navigate')}</span>
          </span>
          <span className="kbd-row">
            <kbd className="kbd">Enter</kbd>
            <span>{t('palette.openHint')}</span>
          </span>
          <span style={{ flex: 1 }} />
          <span>{t('palette.toggleHint', { app: APP_NAME })}</span>
        </div>
      </div>
    </div>
  );
}
