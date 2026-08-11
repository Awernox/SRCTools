/**
 * Player URLs for watching a submitted video without leaving the app.
 *
 * Only the providers with a documented, cookie-light embed endpoint are here,
 * and each one is also named in the CSP's `frame-src`. That pairing is the whole
 * safety story: a URL this module refuses to build cannot be framed, and a URL
 * it does build points at a host the webview was already told to allow. Nothing
 * here ever frames the submitted URL itself — only an address assembled from a
 * provider ID that has been re-validated below.
 *
 * A platform missing from this list is not a gap to be filled with a generic
 * `<iframe src={submittedUrl}>`. That would frame arbitrary attacker-chosen
 * pages inside the moderator's session; those links keep the "open in browser"
 * button and nothing else.
 */

import type { VideoPlatform } from './types';

/**
 * Provider IDs, as they may appear in a URL we assemble.
 *
 * The Rust side already sanitises these, but this module is what puts the value
 * into an address, so it does its own check rather than inheriting a promise
 * from across the IPC boundary.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Embed {
  /** The `src` to frame. Always https, always a host named in the CSP. */
  url: string;
  /** Provider name, for the player's accessible label. */
  provider: string;
}

/**
 * Twitch refuses to serve its player unless the embedding page's hostname is
 * declared. That is `tauri.localhost` in a packaged build and `localhost` under
 * `vite dev`, so it is read from the document rather than hardcoded.
 */
function parentDomain(): string | null {
  const host = window.location.hostname;
  // A bare IP or an empty host would be rejected by Twitch anyway, and an
  // unexpected value is not worth passing on to a third-party player.
  return /^[a-z0-9.-]{1,255}$/i.test(host) ? host : null;
}

/**
 * The player address for a checked video, or `null` when it cannot be framed.
 *
 * `null` is the ordinary answer for a great many real submissions — a Dropbox
 * link, a Medal clip, a channel page with no video id — and the caller is
 * expected to simply not offer playback rather than to treat it as an error.
 */
export function embedFor(platform: VideoPlatform, videoId: string | null): Embed | null {
  if (videoId === null || !SAFE_ID.test(videoId)) return null;

  switch (platform) {
    case 'you_tube':
      // The `-nocookie` host is the same player without the ad-tracking cookie,
      // which a moderator opening dozens of runs a night should not accumulate.
      return {
        url: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`,
        provider: 'YouTube',
      };

    case 'vimeo':
      // Vimeo ids are numeric; anything else came from a page that was not a
      // video, and framing it would show an error rather than a run.
      return /^\d+$/.test(videoId)
        ? { url: `https://player.vimeo.com/video/${videoId}?dnt=1`, provider: 'Vimeo' }
        : null;

    case 'twitch': {
      const parent = parentDomain();
      if (parent === null) return null;
      // A numeric id is a VOD; anything else is a clip slug. That is the same
      // split the URL parser makes when it extracts the id in the first place.
      const kind = /^\d+$/.test(videoId) ? 'video' : 'clip';
      return {
        url: `https://player.twitch.tv/?${kind}=${videoId}&parent=${parent}&autoplay=false`,
        provider: 'Twitch',
      };
    }

    case 'streamable':
      return { url: `https://streamable.com/e/${videoId}`, provider: 'Streamable' };

    // Everything below either has no embed endpoint, requires an API key, or
    // serves the file from a host that would have to be trusted wholesale.
    case 'bilibili':
    case 'nico_video':
    case 'google_drive':
    case 'dropbox':
    case 'medal':
    case 'other':
      return null;
  }
}
