/**
 * The shell: brand, sidebar, top bar, the current page and the status bar.
 *
 * One place wires the ready handshake. The window is created hidden so the
 * webview can boot without showing a white flash; only after the backend has
 * reported ready, layout is loaded and the first paint has happened does the
 * window become visible.
 */

import { useCallback, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { Brand } from './components/Brand';
import { TopBar, StatusBar } from './components/Chrome';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutHelp } from './components/ShortcutHelp';
import { Sidebar } from './components/Sidebar';
import { ConfirmDialog, Toasts } from './components/Toasts';
import { UpdateDialog } from './components/UpdateDialog';
import { t } from './i18n';
import { Pages } from './pages';
import { Setup } from './pages/Setup';
import { useLivePresence } from './hooks/usePresence';
import { useShortcuts } from './hooks/useShortcuts';
import { useApp } from './store/app';
import { useDashboard } from './store/dashboard';
import { useDetail } from './store/detail';
import { useDiscord, publishPresence, useWebhook } from './store/integrations';
import { useQueue } from './store/queue';
import { useSession } from './store/session';
import { useModeration } from './store/moderation';
import { useUi } from './store/ui';
import { useUpdate } from './store/update';
import { useWatcher } from './store/watcher';
import type { DiscordStatus, NewRunsEvent, WatcherStatus } from './ipc';
import type { BulkProgress, Profile, StartupReport } from './types';

/** Payload of `srctools://notification-activated`. */
interface NotificationActivation {
  page: string;
  runId?: string | null;
}

export default function App() {
  const page = useApp((state) => state.page);
  const go = useApp((state) => state.go);
  const gameId = useApp((state) => state.gameId);
  const fastReview = useApp((state) => state.fastReview);
  const sidebarCollapsed = useApp((state) => state.layout.sidebarCollapsed);
  // Hiding the labels is what makes the column narrow, whether that came from
  // the collapse control or from the standing preference.
  const sidebarText = useSession((state) => state.settings.sidebarText);
  const sidebarPosition = useSession((state) => state.settings.sidebarPosition);
  const togglePalette = useApp((state) => state.togglePalette);
  const toggleHelp = useApp((state) => state.toggleHelp);
  const loadLayout = useApp((state) => state.loadLayout);
  const layoutLoaded = useApp((state) => state.layoutLoaded);

  const ready = useSession((state) => state.ready);
  const startup = useSession((state) => state.startup);
  const hasApiKey = useSession((state) => state.hasApiKey);
  const authLoading = useSession((state) => state.authLoading);
  const init = useSession((state) => state.init);
  const setStartup = useSession((state) => state.setStartup);
  const setProfile = useSession((state) => state.setProfile);
  const refreshGames = useSession((state) => state.refreshGames);

  const notifyNewRuns = useSession((state) => state.settings.notifyNewRuns);
  const notifyVideoProblems = useSession((state) => state.settings.notifyVideoProblems);
  const webhookEnabled = useSession((state) => state.settings.webhookEnabled);
  const webhookReady = useWebhook((state) => state.status.configured);
  const checkInterval = useSession((state) => state.settings.checkInterval);

  const discordEnabled = useSession((state) => state.settings.discordEnabled);
  const discordAppId = useSession((state) => state.settings.discordAppId);
  const presence = useLivePresence();

  /** Lets the moderator use the local pages (history, settings) without a key. */
  const [skipSetup, setSkipSetup] = useState(false);

  useEffect(() => {
    void init();
    void loadLayout();

    const stops: Array<() => void> = [];
    let cancelled = false;
    const track = (promise: Promise<() => void>) => {
      void promise.then((stop) => {
        if (cancelled) stop();
        else stops.push(stop);
      });
    };

    track(
      listen<StartupReport>('srctools://ready', (event) => {
        setStartup(event.payload);
      }),
    );
    // The identity resolves in the background on the Rust side, so the shell
    // learns who is signed in without blocking its own first paint.
    track(listen<Profile>('srctools://profile', (event) => setProfile(event.payload)));
    track(
      listen<BulkProgress>('srctools://bulk-progress', (event) =>
        useModeration.getState().onProgress(event.payload),
      ),
    );
    // A clicked Windows notification lands here: the Rust side has already
    // brought the window forward, and this opens what it was about.
    track(
      listen<NotificationActivation>('srctools://notification-activated', (event) => {
        const { page: target, runId } = event.payload;
        const app = useApp.getState();
        if (target === 'queue') app.go('queue');
        if (runId) {
          app.openDetail(runId);
          useQueue.getState().focusRun(runId);
        }
      }),
    );

    // The presence worker reports its own connection changes: Discord starting
    // or quitting is not something the shell can otherwise observe.
    track(
      listen<DiscordStatus>('srctools://discord', (event) =>
        useDiscord.getState().apply(event.payload),
      ),
    );

    // The watcher polls on the Rust side, so both of these arrive on the
    // moderator's chosen cadence whether or not this window is in front.
    track(
      listen<NewRunsEvent>('srctools://new-runs', (event) =>
        useWatcher.getState().onRuns(event.payload),
      ),
    );
    // Verdicts reached anywhere — by another moderator, or by this one on the
    // Speedrun.com site. The app cannot learn about those from its own actions,
    // and most verdicts are not reached in this window.
    track(
      listen<NewRunsEvent>('srctools://approved-runs', (event) =>
        useWatcher.getState().onApproved(event.payload),
      ),
    );
    track(
      listen<NewRunsEvent>('srctools://rejected-runs', (event) =>
        useWatcher.getState().onRejected(event.payload),
      ),
    );
    track(
      listen<WatcherStatus>('srctools://watcher', (event) =>
        useWatcher.getState().onStatus(event.payload),
      ),
    );

    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, [init, loadLayout, setProfile, setStartup]);

  // The window stays hidden until React has something real to show.
  const painted = ready && layoutLoaded;
  useEffect(() => {
    if (!painted) return;
    const window = getCurrentWindow();
    void window.show().catch(() => undefined);
    void window.setFocus().catch(() => undefined);
  }, [painted]);

  /** Reloads whatever the current page shows. */
  const refresh = useCallback(() => {
    if (page === 'queue') void useQueue.getState().load(true);
    else if (page === 'dashboard') void useDashboard.getState().load(true);
    else if (page === 'games') void refreshGames();
  }, [page, refreshGames]);

  // First load once the backend has reported in and a key exists. Not done in
  // `init`: the queue and dashboard both cost requests, and `init` also runs on
  // the setup path where nothing is connected yet.
  useEffect(() => {
    if (!ready || !startup?.hasApiKey) return;
    void useQueue.getState().load(true);
    void useDashboard.getState().load(true);
  }, [ready, startup]);

  // The watcher follows the settings: it polls when a key exists and something
  // is listening for what it finds, re-times itself when the interval changes,
  // and stops otherwise. `sync` hands the outcome to the Rust loop, which owns
  // the timer — a webview one would be throttled to about once a minute in the
  // background, which is precisely when notifications matter.
  //
  // Every input to that decision is listed: the webhook is one of the surfaces
  // the loop feeds, so turning it on has to start the loop.
  useEffect(() => {
    if (!ready) return;
    void useWatcher.getState().sync();
  }, [
    ready,
    hasApiKey,
    notifyNewRuns,
    notifyVideoProblems,
    webhookEnabled,
    webhookReady,
    checkInterval,
  ]);

  useEffect(() => () => void useWatcher.getState().stop(), []);

  // Whether a webhook is saved has to be known before the first run arrives:
  // the watcher asks this store rather than the vault on every poll.
  useEffect(() => {
    if (!ready) return;
    void useWebhook.getState().load();
  }, [ready]);

  // Rich Presence follows the two settings that decide whether it exists at
  // all. Connecting happens on a background thread, so this returns straight
  // away whether or not Discord is running.
  useEffect(() => {
    if (!ready) return;
    void useDiscord.getState().configure(discordEnabled, discordAppId);
  }, [ready, discordEnabled, discordAppId]);

  // …and then follows the app. `useLivePresence` returns a stable object while
  // nothing it depends on changes, so this only fires on a real change; the
  // Rust side coalesces whatever still arrives too quickly.
  useEffect(() => {
    if (!ready || !discordEnabled) return;
    publishPresence(presence);
  }, [ready, discordEnabled, presence]);

  // Startup warnings (a broken credential vault, a cache that could not be
  // tidied) are surfaced once rather than logged where nobody would see them.
  useEffect(() => {
    if (!startup) return;
    for (const warning of startup.warnings) {
      useUi.getState().warning(t('open.startupWarning'), warning);
    }
  }, [startup]);

  // One update check per launch, a few seconds in so it does not compete with
  // the first queue load. It stays quiet unless GitHub really has a newer
  // release: nothing to report means nothing appears.
  useEffect(() => {
    if (!ready) return;
    useUpdate.getState().checkOnStartup();
  }, [ready]);

  // The one place the shortcut set is declared. Pages add their own handlers
  // through the same hook; an action with no handler on this page does nothing.
  useShortcuts(
    {
      gotoDashboard: () => go('dashboard'),
      gotoQueue: () => go('queue'),
      gotoHistory: () => go('history'),
      gotoStats: () => go('stats'),
      gotoSettings: () => go('settings'),
      help: () => toggleHelp(),
      commandPalette: () => togglePalette(),
      refresh,
      escape: () => {
        const app = useApp.getState();
        // A confirmation dialog owns Escape while it is open; closing the panel
        // underneath it would leave the moderator looking at nothing.
        if (useUi.getState().confirm) return;
        if (app.paletteOpen) togglePalette(false);
        else if (app.helpOpen) toggleHelp(false);
        else if (app.detailRunId) {
          app.closeDetail();
          useDetail.getState().close();
        } else if (app.fastReview) app.setFastReview(false);
      },
    },
    ready,
  );

  if (!painted) {
    return (
      <div className="boot-splash">
        <div className="boot-splash__mark" />
      </div>
    );
  }

  // No key and nothing skipped: the setup screen is the whole window, because
  // every other page would be empty anyway.
  if (!hasApiKey && !authLoading && !skipSetup) {
    return <Setup onSkip={() => setSkipSetup(true)} />;
  }

  return (
    <div
      className="app"
      data-sidebar-collapsed={sidebarCollapsed || !sidebarText}
      data-sidebar-position={sidebarPosition}
    >
      <Brand />
      <Sidebar />
      <TopBar onRefresh={refresh} />
      <main className="main">
        <Pages page={page} gameId={gameId} fastReview={fastReview} />
      </main>
      <StatusBar />
      <CommandPalette />
      <ShortcutHelp />
      <Toasts />
      <ConfirmDialog />
      <UpdateDialog />
    </div>
  );
}
