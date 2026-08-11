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
      ui.warning('Type at least two characters', 'Speedrun.com rejects shorter searches.');
      return;
    }
    setSearching(true);
    try {
      setRemote(await library.searchGames(query.trim(), 24));
    } catch (err) {
      ui.error('Could not search Speedrun.com', err);
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
          title="Not connected to Speedrun.com"
          hint="Add your API key in Settings to see the games you moderate."
          action={
            <button type="button" className="btn btn--primary" onClick={() => go('settings')}>
              Open Settings
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
          <h2 className="h1">Games</h2>
          <p className="page__subtitle">
            {loading && games.length === 0
              ? 'Loading the games you moderate…'
              : `${plural(games.length, 'game')} you moderate. Open one to read its rules.`}
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
            Refresh
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__group" style={{ flex: 1, minWidth: 0 }}>
          <Search size={14} style={{ color: 'var(--text-tertiary)' }} />
          <input
            className="input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="Filter your games, or search all of Speedrun.com"
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
          Search Speedrun.com
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
          title="No moderated games"
          hint="Speedrun.com does not list you as a moderator on any game. You can still search for a game to read its rules."
        />
      )}

      {mine.length > 0 && (
        <>
          <div className="section__title" style={{ marginTop: 4 }}>
            <ListChecks size={13} />
            {needle ? `${plural(mine.length, 'match')} in your games` : 'Games you moderate'}
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
          title={`Nothing of yours matches “${query.trim()}”`}
          hint="Search Speedrun.com to look it up anyway — you can read any game's rules, even one you do not moderate."
          action={
            <button type="button" className="btn btn--primary" onClick={() => void searchRemote()}>
              Search Speedrun.com
            </button>
          }
        />
      )}

      {remote !== null && (
        <>
          <div className="section__title" style={{ marginTop: 16 }}>
            <Search size={13} />
            Speedrun.com results
          </div>
          {remote.length === 0 ? (
            <EmptyState title="No games matched" hint={`Speedrun.com found nothing for “${query.trim()}”.`} />
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
          {game.abbreviation ?? '—'}
          {game.released !== null && ` · ${game.released}`}
        </span>
        {game.isModerator && (
          <span>
            <Badge tone="accent" small>
              Moderator
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
        ui.success('Unpinned', `${bundle.game.name} was removed from the sidebar.`);
      } else {
        await prefs.addFavorite(
          gameId,
          bundle.game.name,
          bundle.game.abbreviation,
          bundle.game.coverUrl,
        );
        ui.success('Pinned', `${bundle.game.name} is now in the sidebar.`);
      }
      await refreshFavorites();
    } catch (err) {
      ui.error('Could not update your pinned games', err);
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
      All games
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
          title="Could not load this game"
          message={error ?? 'Speedrun.com returned nothing for this game id.'}
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
          <p className="page__subtitle">
            {game.abbreviation ?? 'No abbreviation'}
            {game.releaseDate !== null && ` · released ${formatDate(game.releaseDate)}`}
            {game.isModerator
              ? ` · you are a ${game.moderatorRole ?? 'moderator'} here`
              : ' · you do not moderate this game'}
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void togglePin()}
            disabled={pinning}
          >
            {pinned ? <StarOff size={13} /> : <Star size={13} />}
            {pinned ? 'Unpin' : 'Pin to sidebar'}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void openExternal(game.weblink)}
            disabled={game.weblink === null}
          >
            <ExternalLink size={13} />
            Open on Speedrun.com
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={reviewThisGame}>
            <ListChecks size={13} />
            Review this game
          </button>
        </div>
      </div>

      {!game.isModerator && (
        <div className="notice notice--info">
          <Info size={15} />
          <span>
            You are not listed as a moderator of this game, so verifying or rejecting its runs will
            be refused by Speedrun.com. The rules below are still readable.
          </span>
        </div>
      )}

      <div className="col" style={{ gap: 16, marginTop: 16 }}>
        <Card title="Submission rules" icon={<BookOpen size={13} />}>
          <div className="dl">
            <RuleFlag label="Video required" value={game.requireVideo} />
            <RuleFlag label="Verification required" value={game.requireVerification} />
            <RuleFlag label="Emulators allowed" value={game.emulatorsAllowed} />
            <RuleFlag label="Romhack" value={game.romhack} />
            <RuleFlag label="Milliseconds shown" value={game.showMilliseconds} />

            <span className="dl__key">Default timing</span>
            <span className="dl__val">
              {game.defaultTime ?? <span className="absent">not stated</span>}
            </span>

            <span className="dl__key">Timing methods</span>
            <span className="dl__val">
              {game.runTimes.length > 0 ? (
                game.runTimes.join(', ')
              ) : (
                <span className="absent">not stated</span>
              )}
            </span>
          </div>
        </Card>

        <Card
          title="Rules and structure"
          icon={<Layers size={13} />}
          actions={
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'categories', label: 'Categories', count: categories.length },
                { value: 'levels', label: 'Levels', count: levels.length },
                { value: 'variables', label: 'Variables', count: variables.length },
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
  return (
    <>
      <span className="dl__key">{label}</span>
      <span className="dl__val">
        {value === null ? (
          <Tooltip
            label="Not stated"
            detail="Speedrun.com did not return this setting for this game. That is not the same as “no”."
          >
            <span className="absent">not stated</span>
          </Tooltip>
        ) : (
          <Badge tone={value ? 'ok' : 'neutral'} small>
            {value ? 'Yes' : 'No'}
          </Badge>
        )}
      </span>
    </>
  );
}

function CategoryList({ categories }: { categories: CategoryInfo[] }) {
  if (categories.length === 0) {
    return (
      <EmptyState
        title="No categories loaded"
        hint="Speedrun.com returned no categories for this game, or the request failed."
      />
    );
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
                Misc
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
              <span>
                This category has no rules text on Speedrun.com. That is not the same as having no
                rules — check the game's forum or the moderators.
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function LevelList({ levels }: { levels: Level[] }) {
  if (levels.length === 0) {
    return (
      <EmptyState title="No individual levels" hint="This game has no level leaderboards." />
    );
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
              No level-specific rules were given.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function VariableList({ variables }: { variables: Variable[] }) {
  if (variables.length === 0) {
    return (
      <EmptyState
        title="No variables"
        hint="This game defines no subcategories or extra fields on its submissions."
      />
    );
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Variable</th>
          <th>Scope</th>
          <th>Values</th>
          <th>Required</th>
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
                    Subcategory
                  </Badge>
                </>
              )}
            </td>
            <td className="dim">{variable.scope ?? '—'}</td>
            <td>
              {variable.values.length === 0 ? (
                <span className="absent">—</span>
              ) : (
                variable.values.map((value) => value.label).join(', ')
              )}
            </td>
            <td>
              {variable.mandatory === null ? (
                <span className="absent">not stated</span>
              ) : (
                <Badge tone={variable.mandatory ? 'warn' : 'neutral'} small>
                  {variable.mandatory ? 'Yes' : 'No'}
                </Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
