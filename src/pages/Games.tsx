/**
 * Games: the library of games this account moderates, and one game in detail.
 *
 * The detail view exists to answer the question a moderator actually has open a
 * run alongside — "what do this game's rules say?" — so it shows the game's own
 * settings and the category rules verbatim, as plain text.
 *
 * Every rule flag is tri-state. Speedrun.com's API omits these fields rather
 * than returning `false`, so a missing `requireVideo` means *the game has not
 * said*, not *video is optional*. Rendering those as a "no" would put words in
 * the game's mouth, so they render as "not stated".
 */

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ExternalLink,
  Gamepad2,
  Info,
  Layers,
  ListChecks,
  RefreshCw,
  Search,
  Star,
  StarOff,
  Tag,
} from 'lucide-react';

import {
  Absent,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  Tabs,
  Tooltip,
} from '../components/ui';
import { formatDate, formatNumber, plural } from '../format';
import { useT, type Translate } from '../i18n';
import { errorText, library, prefs } from '../ipc';
import { openExternal } from '../open';
import { useApp } from '../store/app';
import { useQueue } from '../store/queue';
import { useSession } from '../store/session';
import { ui } from '../store/ui';
import type { CategoryInfo, GameInfo, GameSummary, Level, Variable } from '../types';

export function Games({ gameId }: { gameId: string | null }) {
  return gameId === null ? <GameList /> : <GameDetail gameId={gameId} />;
}

/* ------------------------------------------------------------------- list */

function GameList() {
  const t = useT();
  const games = useSession((state) => state.games);
  const loading = useSession((state) => state.gamesLoading);
  const error = useSession((state) => state.gamesError);
  const refreshGames = useSession((state) => state.refreshGames);
  const hasApiKey = useSession((state) => state.hasApiKey);

  const openGame = useApp((state) => state.openGame);
  const go = useApp((state) => state.go);

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<GameSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  const needle = query.trim().toLowerCase();
  const mine = needle
    ? games.filter(
        (game) =>
          game.name.toLowerCase().includes(needle) ||
          (game.abbreviation ?? '').toLowerCase().includes(needle),
      )
    : games;

  // Searching all of Speedrun.com is a deliberate second step rather than
  // something that fires on every keystroke: it is a network call, and the
  // local list answers most questions on its own.
  const searchRemote = async () => {
    if (needle.length < 2) {
      ui.warning(t('games.searchTooShort'), t('games.searchTooShortHint'));
      return;
    }
    setSearching(true);
    try {
      setRemote(await library.searchGames(query.trim(), 24));
    } catch (err) {
      ui.error(t('games.searchFailed'), err);
      setRemote(null);
    } finally {
      setSearching(false);
    }
  };

  if (!hasApiKey) {
    return (
      <div className="page">
        <EmptyState
          icon={<Gamepad2 size={26} />}
          title={t('queue.noKey')}
          hint={t('games.noKeyHint')}
          action={
            <button type="button" className="btn btn--primary" onClick={() => go('settings')}>
              {t('queue.openSettings')}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          <h2 className="h1">{t('games.title')}</h2>
          <p className="page__subtitle">
            {loading && games.length === 0
              ? t('games.loading')
              : t('games.subtitle', { games: plural(games.length, 'game') })}
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void refreshGames()}
            disabled={loading}
          >
            {loading ? <Spinner /> : <RefreshCw size={13} />}
            {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__group" style={{ flex: 1, minWidth: 0 }}>
          <Search size={14} style={{ color: 'var(--text-tertiary)' }} />
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder={t('games.filterPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setRemote(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void searchRemote();
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void searchRemote()}
          disabled={searching}
        >
          {searching ? <Spinner /> : <Search size={13} />}
          {t('games.searchSrc')}
        </button>
      </div>

      {error !== null && <ErrorState message={error} onRetry={() => void refreshGames()} />}

      {error === null && loading && games.length === 0 && (
        <div className="grid-cards">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div className="game-card" key={n}>
              <Skeleton width={42} height={58} radius={6} />
              <div className="game-card__body">
                <Skeleton width={120} height={12} />
                <Skeleton width={70} height={9} />
              </div>
            </div>
          ))}
        </div>
      )}

      {error === null && !loading && games.length === 0 && (
        <EmptyState
          icon={<Gamepad2 size={26} />}
          title={t('games.noneModerated')}
          hint={t('games.noneModeratedHint')}
        />
      )}

      {mine.length > 0 && (
        <>
          <div className="section__title" style={{ marginTop: 4 }}>
            <ListChecks size={13} />
            {needle
              ? t('games.matchesInYours', { matches: plural(mine.length, 'match') })
              : t('games.yourGames')}
          </div>
          <div className="grid-cards">
            {mine.map((game) => (
              <GameCard key={game.id} game={game} onOpen={() => openGame(game.id)} />
            ))}
          </div>
        </>
      )}

      {needle.length > 0 && mine.length === 0 && remote === null && (
        <EmptyState
          icon={<Search size={24} />}
          title={t('games.noLocalMatch', { query: query.trim() })}
          hint={t('games.noLocalMatchHint')}
          action={
            <button type="button" className="btn btn--primary" onClick={() => void searchRemote()}>
              {t('games.searchSrc')}
            </button>
          }
        />
      )}

      {remote !== null && (
        <>
          <div className="section__title" style={{ marginTop: 16 }}>
            <Search size={13} />
            {t('games.srcResults')}
          </div>
          {remote.length === 0 ? (
            <EmptyState
              title={t('games.noRemoteMatch')}
              hint={t('games.noRemoteMatchHint', { query: query.trim() })}
            />
          ) : (
            <div className="grid-cards">
              {remote.map((game) => (
                <GameCard key={game.id} game={game} onOpen={() => openGame(game.id)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GameCard({ game, onOpen }: { game: GameSummary; onOpen: () => void }) {
  const t = useT();
  return (
    <button type="button" className="game-card" onClick={onOpen} title={game.name}>
      {game.coverUrl !== null ? (
        <img className="game-card__cover" src={game.coverUrl} alt="" loading="lazy" />
      ) : (
        <span className="game-card__cover" style={{ display: 'grid', placeItems: 'center' }}>
          <Gamepad2 size={16} style={{ color: 'var(--text-tertiary)' }} />
        </span>
      )}
      <span className="game-card__body">
        <span className="game-card__name">{game.name}</span>
        <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
          {game.abbreviation ?? <Absent />}
          {game.released !== null && ` · ${game.released}`}
        </span>
        {game.isModerator && (
          <span>
            <Badge tone="accent" small>
              {t('games.moderatorBadge')}
            </Badge>
          </span>
        )}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- detail */

type DetailTab = 'categories' | 'levels' | 'variables';

interface GameBundle {
  game: GameInfo;
  categories: CategoryInfo[];
  levels: Level[];
  variables: Variable[];
}

function GameDetail({ gameId }: { gameId: string }) {
  const t = useT();
  const openGame = useApp((state) => state.openGame);
  const go = useApp((state) => state.go);

  const favorites = useSession((state) => state.favorites);
  const refreshFavorites = useSession((state) => state.refreshFavorites);

  const [bundle, setBundle] = useState<GameBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('categories');
  const [pinning, setPinning] = useState(false);
  // Bumped by "Try again". Re-navigating to the same game id would not change
  // any dependency, so the fetch needs something of its own to react to.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBundle(null);

    void (async () => {
      try {
        const game = await library.game(gameId);
        // The three lists are independent of one another, so one failing should
        // not blank the whole page — each falls back to empty and the section
        // says so.
        const [categories, levels, variables] = await Promise.all([
          library.categories(gameId).catch(() => [] as CategoryInfo[]),
          library.levels(gameId).catch(() => [] as Level[]),
          library.variables(gameId).catch(() => [] as Variable[]),
        ]);
        if (!cancelled) {
          setBundle({ game, categories, levels, variables });
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [gameId, reload]);

  const pinned = favorites.some((favorite) => favorite.gameId === gameId);

  const togglePin = async () => {
    if (!bundle) return;
    setPinning(true);
    try {
      if (pinned) {
        await prefs.removeFavorite(gameId);
        ui.success(t('games.unpinned'), t('games.unpinnedHint', { game: bundle.game.name }));
      } else {
        await prefs.addFavorite(
          gameId,
          bundle.game.name,
          bundle.game.abbreviation,
          bundle.game.coverUrl,
        );
        ui.success(t('games.pinned'), t('games.pinnedHint', { game: bundle.game.name }));
      }
      await refreshFavorites();
    } catch (err) {
      ui.error(t('games.pinFailed'), err);
    } finally {
      setPinning(false);
    }
  };

  const reviewThisGame = () => {
    void useQueue.getState().setFilter({ gameId, onlyMyGames: false });
    go('queue');
  };

  const back = (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => openGame(null)}>
      <ArrowLeft size={13} />
      {t('games.allGames')}
    </button>
  );

  if (loading) {
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__heading">
            {back}
            <Skeleton width={260} height={22} />
          </div>
        </div>
        <Skeleton height={120} radius={10} />
      </div>
    );
  }

  if (error !== null || !bundle) {
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__heading">{back}</div>
        </div>
        <ErrorState
          title={t('games.loadFailed')}
          message={error ?? t('games.loadFailedEmpty')}
          onRetry={() => setReload((n) => n + 1)}
        />
      </div>
    );
  }

  const { game, categories, levels, variables } = bundle;

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__heading">
          {back}
          <h2 className="h1" style={{ marginTop: 6 }}>
            {game.name}
          </h2>
          <p className="page__subtitle">{detailSubtitle(game, t)}</p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void togglePin()}
            disabled={pinning}
          >
            {pinned ? <StarOff size={13} /> : <Star size={13} />}
            {pinned ? t('games.unpin') : t('games.pin')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void openExternal(game.weblink)}
            disabled={game.weblink === null}
          >
            <ExternalLink size={13} />
            {t('action.openOnSrc')}
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={reviewThisGame}>
            <ListChecks size={13} />
            {t('games.reviewThis')}
          </button>
        </div>
      </div>

      {!game.isModerator && (
        <div className="notice notice--info">
          <Info size={15} />
          <span>{t('games.notModeratorNotice')}</span>
        </div>
      )}

      <div className="col" style={{ gap: 16, marginTop: 16 }}>
        <Card title={t('games.rules')} icon={<BookOpen size={13} />}>
          <div className="dl">
            <RuleFlag label={t('games.flag.video')} value={game.requireVideo} />
            <RuleFlag label={t('games.flag.verification')} value={game.requireVerification} />
            <RuleFlag label={t('games.flag.emulators')} value={game.emulatorsAllowed} />
            <RuleFlag label={t('games.flag.romhack')} value={game.romhack} />
            <RuleFlag label={t('games.flag.milliseconds')} value={game.showMilliseconds} />

            <span className="dl__key">{t('games.defaultTiming')}</span>
            <span className="dl__val">{game.defaultTime ?? <NotStated />}</span>

            <span className="dl__key">{t('games.timingMethods')}</span>
            <span className="dl__val">
              {game.runTimes.length > 0 ? game.runTimes.join(', ') : <NotStated />}
            </span>
          </div>
        </Card>

        <Card
          title={t('games.structure')}
          icon={<Layers size={13} />}
          actions={
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'categories', label: t('games.categories'), count: categories.length },
                { value: 'levels', label: t('games.levels'), count: levels.length },
                { value: 'variables', label: t('games.variables'), count: variables.length },
              ]}
            />
          }
        >
          {tab === 'categories' && <CategoryList categories={categories} />}
          {tab === 'levels' && <LevelList levels={levels} />}
          {tab === 'variables' && <VariableList variables={variables} />}
        </Card>
      </div>
    </div>
  );
}

/**
 * A tri-state rule flag.
 *
 * `null` is rendered as "not stated" rather than "No". Speedrun.com omits these
 * fields when a game has not configured them, and a moderator must not read an
 * omission as a rule.
 */
function RuleFlag({ label, value }: { label: string; value: boolean | null }) {
  const t = useT();
  return (
    <>
      <span className="dl__key">{label}</span>
      <span className="dl__val">
        {value === null ? (
          <Tooltip label={t('games.notStatedTitle')} detail={t('games.notStatedDetail')}>
            <NotStated />
          </Tooltip>
        ) : (
          <Badge tone={value ? 'ok' : 'neutral'} small>
            {value ? t('common.yes') : t('common.no')}
          </Badge>
        )}
      </span>
    </>
  );
}

/**
 * "not stated" — a setting the game never configured.
 *
 * Deliberately not the em dash [`Absent`] uses: that one means Speedrun.com
 * returned no value for a run, this one means the game's own rules are silent,
 * and conflating the two would let a moderator read one as the other.
 */
function NotStated() {
  const t = useT();
  return <span className="absent">{t('common.notStated')}</span>;
}

/**
 * The line under a game's name: abbreviation, release date, and your standing.
 *
 * Built by joining whole clauses rather than by appending fragments, so each
 * part can be reordered or reworded by a translation instead of being locked to
 * English word order by a leading " · ".
 */
function detailSubtitle(game: GameInfo, t: Translate): string {
  const parts = [game.abbreviation ?? t('games.noAbbreviation')];
  if (game.releaseDate !== null) {
    parts.push(t('games.released', { date: formatDate(game.releaseDate) }));
  }
  parts.push(
    game.isModerator
      ? t('games.youAreRole', { role: game.moderatorRole ?? t('games.roleModerator') })
      : t('games.notModerating'),
  );
  return parts.join(' · ');
}

function CategoryList({ categories }: { categories: CategoryInfo[] }) {
  const t = useT();
  if (categories.length === 0) {
    return <EmptyState title={t('games.noCategories')} hint={t('games.noCategoriesHint')} />;
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {categories.map((category) => (
        <div key={category.id}>
          <div className="section__title" style={{ marginBottom: 6 }}>
            <Tag size={13} />
            {category.name}
            {category.miscellaneous === true && (
              <Badge tone="neutral" small>
                {t('games.misc')}
              </Badge>
            )}
            {category.playerType !== null && (
              <Badge tone="info" small outline>
                {category.playerCount !== null
                  ? `${category.playerType} ${formatNumber(category.playerCount)}`
                  : category.playerType}
              </Badge>
            )}
            {category.weblink !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void openExternal(category.weblink)}
              >
                <ExternalLink size={11} />
              </button>
            )}
          </div>
          {category.rules !== null && category.rules.trim().length > 0 ? (
            <div className="rules" data-selectable>
              {category.rules}
            </div>
          ) : (
            <div className="notice notice--unknown">
              <Info size={15} />
              <span>{t('games.noCategoryRules')}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LevelList({ levels }: { levels: Level[] }) {
  const t = useT();
  if (levels.length === 0) {
    return <EmptyState title={t('games.noLevels')} hint={t('games.noLevelsHint')} />;
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {levels.map((level) => (
        <div key={level.id}>
          <div className="section__title" style={{ marginBottom: 6 }}>
            <Layers size={13} />
            {level.name}
            {level.weblink !== null && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void openExternal(level.weblink)}
              >
                <ExternalLink size={11} />
              </button>
            )}
          </div>
          {level.rules !== null && level.rules.trim().length > 0 ? (
            <div className="rules" data-selectable>
              {level.rules}
            </div>
          ) : (
            <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
              {t('games.noLevelRules')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function VariableList({ variables }: { variables: Variable[] }) {
  const t = useT();
  if (variables.length === 0) {
    return <EmptyState title={t('games.noVariables')} hint={t('games.noVariablesHint')} />;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('games.var.name')}</th>
          <th>{t('games.var.scope')}</th>
          <th>{t('games.var.values')}</th>
          <th>{t('games.var.required')}</th>
        </tr>
      </thead>
      <tbody>
        {variables.map((variable) => (
          <tr key={variable.id}>
            <td>
              {variable.name}
              {variable.isSubcategory === true && (
                <>
                  {' '}
                  <Badge tone="accent" small>
                    {t('detail.facts.subcategory')}
                  </Badge>
                </>
              )}
            </td>
            <td className="dim">{variable.scope ?? <Absent />}</td>
            <td>
              {variable.values.length === 0 ? (
                <Absent />
              ) : (
                variable.values.map((value) => value.label).join(', ')
              )}
            </td>
            <td>
              {variable.mandatory === null ? (
                <NotStated />
              ) : (
                <Badge tone={variable.mandatory ? 'warn' : 'neutral'} small>
                  {variable.mandatory ? t('common.yes') : t('common.no')}
                </Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
