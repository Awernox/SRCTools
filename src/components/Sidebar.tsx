/**
 * Sidebar: navigation, favourite games and the signed-in account.
 *
 * The brand mark sits above it in `Shell`; this is the navigation column only.
 *
 * Two independent things hide the labels: the collapse control in the chrome,
 * which is a moment's decision, and the `sidebarText` preference, which is a
 * standing one. Either is enough, so the tooltip appears whenever the label is
 * gone rather than only when the strip is collapsed.
 */

import {
  BarChart3,
  Gamepad2,
  History,
  LayoutDashboard,
  ListChecks,
  Settings,
  Star,
  X,
} from 'lucide-react';

import { initials } from '../format';
import { useT, type TranslationKey } from '../i18n';
import { openExternal } from '../open';
import { useApp, type PageId } from '../store/app';
import { useDashboard } from '../store/dashboard';
import { useSession } from '../store/session';
import { prefs } from '../ipc';
import { Tooltip } from './ui';

const NAV: Array<{ id: PageId; label: TranslationKey; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'nav.dashboard', icon: LayoutDashboard },
  { id: 'queue', label: 'nav.queue', icon: ListChecks },
  { id: 'games', label: 'nav.games', icon: Gamepad2 },
  { id: 'history', label: 'nav.history', icon: History },
  { id: 'stats', label: 'nav.stats', icon: BarChart3 },
  { id: 'settings', label: 'nav.settings', icon: Settings },
];

export function Sidebar() {
  const t = useT();
  const page = useApp((state) => state.page);
  const go = useApp((state) => state.go);
  const openGame = useApp((state) => state.openGame);
  const collapsed = useApp((state) => state.layout.sidebarCollapsed);

  const profile = useSession((state) => state.profile);
  const favorites = useSession((state) => state.favorites);
  const refreshFavorites = useSession((state) => state.refreshFavorites);
  const showIcons = useSession((state) => state.settings.sidebarIcons);
  const showText = useSession((state) => state.settings.sidebarText);
  const summary = useDashboard((state) => state.summary);

  const pending = summary?.pendingCount ?? null;
  const labels = showText && !collapsed;
  // With the labels gone the icon is all that is left, so the preference to hide
  // it yields to the collapse control rather than leaving a column of blanks.
  const icons = showIcons || !labels;

  return (
    <nav className="sidebar" aria-label="Main" data-labels={labels}>
      <div className="sidebar__scroll">
        <div className="sidebar__section">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            const label = t(item.label);
            const button = (
              <button
                type="button"
                className={`nav-item${active ? ' nav-item--active' : ''}`}
                onClick={() => go(item.id)}
                aria-current={active ? 'page' : undefined}
                // The icon carries no text, so without a label the button would
                // otherwise announce nothing at all.
                aria-label={labels ? undefined : label}
              >
                {icons && (
                  <span className="nav-item__icon">
                    <Icon size={15} />
                  </span>
                )}
                {labels && <span className="nav-item__label">{label}</span>}
                {labels && item.id === 'queue' && pending !== null && pending > 0 && (
                  <span className="nav-item__count">
                    {summary?.pendingIsPartial ? `${pending}+` : pending}
                  </span>
                )}
              </button>
            );
            return labels ? (
              <div key={item.id}>{button}</div>
            ) : (
              <Tooltip key={item.id} label={label} side="bottom">
                {button}
              </Tooltip>
            );
          })}
        </div>

        {favorites.length > 0 && (
          <div className="sidebar__section">
            {labels && (
              <div className="sidebar__heading">
                <span>{t('nav.pinned')}</span>
                <Star size={11} />
              </div>
            )}
            {favorites.map((favorite) => {
              const name = favorite.abbrev ?? favorite.name;
              const button = (
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => openGame(favorite.gameId)}
                  title={favorite.name}
                  aria-label={labels ? undefined : favorite.name}
                >
                  {icons && (
                    <span className="nav-item__icon">
                      {favorite.coverUrl ? (
                        <img
                          src={favorite.coverUrl}
                          alt=""
                          style={{ width: 14, height: 18, objectFit: 'cover', borderRadius: 2 }}
                        />
                      ) : (
                        <Gamepad2 size={14} />
                      )}
                    </span>
                  )}
                  {labels && <span className="nav-item__label">{name}</span>}
                </button>
              );

              return (
                <div key={favorite.gameId} style={{ position: 'relative' }}>
                  {labels ? button : <Tooltip label={favorite.name} side="bottom">{button}</Tooltip>}
                  {/* Unpinning needs a target to aim at. With the labels gone the
                      row is a bare icon, and a second control on top of it would
                      be a coin flip which one you hit. */}
                  {labels && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      title={t('nav.unpin')}
                      aria-label={t('nav.unpin')}
                      style={{ position: 'absolute', right: 4, top: 3 }}
                      onClick={async () => {
                        await prefs.removeFavorite(favorite.gameId).catch(() => undefined);
                        void refreshFavorites();
                      }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        {profile ? (
          <button
            type="button"
            className="account"
            title={t('nav.openProfile', { name: profile.displayName })}
            onClick={() => void openExternal(profile.weblink)}
          >
            {profile.avatarUrl ? (
              <img className="account__avatar" src={profile.avatarUrl} alt="" />
            ) : (
              <span
                className="account__avatar"
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                {initials(profile.displayName)}
              </span>
            )}
            {labels && (
              <span className="account__text">
                <span className="account__name">{profile.displayName}</span>
                <span className="account__sub">{profile.role ?? t('nav.signedIn')}</span>
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            className="account"
            onClick={() => go('settings')}
            title={labels ? undefined : t('nav.notConnected')}
          >
            <span
              className="account__avatar"
              style={{ display: 'grid', placeItems: 'center', color: 'var(--text-tertiary)' }}
            >
              <Settings size={13} />
            </span>
            {labels && (
              <span className="account__text">
                <span className="account__name">{t('nav.notConnected')}</span>
                <span className="account__sub">{t('nav.addKey')}</span>
              </span>
            )}
          </button>
        )}
      </div>
    </nav>
  );
}
