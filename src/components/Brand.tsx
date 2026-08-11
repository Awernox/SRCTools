/**
 * The product mark, in the top-left grid cell of the shell.
 *
 * `BRAND_MARK` is exported so every other place the logo appears — the setup
 * screen, the command palette, the about row in Settings — uses the same asset
 * rather than a second copy that could drift.
 */

import markUrl from '../assets/brand-mark.png';
import { useApp } from '../store/app';
import { useSession } from '../store/session';

/** URL of the bundled logo. Vite rewrites this to a hashed asset path. */
export const BRAND_MARK = markUrl;

export const APP_NAME = 'SRCTools';

export function Brand() {
  const collapsed = useApp((state) => state.layout.sidebarCollapsed);
  const startup = useSession((state) => state.startup);

  return (
    <div className="brand" title={`${APP_NAME}${startup ? ` ${startup.version}` : ''}`}>
      <img className="brand__mark" src={BRAND_MARK} alt={`${APP_NAME} logo`} />
      {!collapsed && (
        <span style={{ minWidth: 0 }}>
          <span className="brand__name">{APP_NAME}</span>
          {startup && <span className="brand__version" style={{ display: 'block' }}>v{startup.version}</span>}
        </span>
      )}
    </div>
  );
}
