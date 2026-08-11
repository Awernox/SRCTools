/**
 * Appearance: theme, accent colour and interface density.
 *
 * The palette itself lives in `styles/tokens.css`. This module only overrides the
 * accent tokens on the root element, and it derives every shade from one base
 * colour so a colour picked in the custom picker behaves exactly like a preset —
 * there is no separate code path for "custom".
 *
 * It lives outside the session store because `system` theme needs a `matchMedia`
 * subscription that has to outlive any single state update, and because the
 * store must not depend on the DOM to be testable.
 */

export type ThemeName = 'dark' | 'light' | 'system';
/** What is actually painted: `system` has already been resolved. */
export type ResolvedTheme = 'dark' | 'light';
export type Density = 'compact' | 'normal' | 'comfortable';

export const THEMES = ['dark', 'light', 'system'] as const;
export const DENSITIES = ['compact', 'normal', 'comfortable'] as const;

/** Base colour per accent. Every other accent token is derived from it. */
export const ACCENT_COLOURS = {
  purple: '#6366f1',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  green: '#22c55e',
  red: '#ef4444',
  orange: '#f97316',
  pink: '#ec4899',
} as const;

export type AccentName = keyof typeof ACCENT_COLOURS | 'custom';

export const ACCENT_NAMES: readonly AccentName[] = [
  'purple',
  'blue',
  'cyan',
  'green',
  'red',
  'orange',
  'pink',
  'custom',
];

export const DEFAULT_CUSTOM_ACCENT = '#8b5cf6';

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function isAccentName(value: unknown): value is AccentName {
  return typeof value === 'string' && (ACCENT_NAMES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ colours */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX = /^#?([0-9a-f]{6})$/i;

/**
 * `#rrggbb`, lower case, or null.
 *
 * Used both for the stored custom colour and for anything read back from an
 * `<input type="color">`, so an unparseable value can fall back rather than
 * writing garbage into a CSS variable.
 */
export function normaliseHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

function toHsl(hex: string): Hsl {
  const int = Number.parseInt(hex.slice(1), 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h, s, l };
}

function channel(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

function toHex({ h, s, l }: Hsl): string {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = channel(p, q, h + 1 / 3);
    g = channel(p, q, h);
    b = channel(p, q, h - 1 / 3);
  }
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Same hue and saturation, a different lightness. */
function atLightness(hex: string, l: number): string {
  const hsl = toHsl(hex);
  return toHex({ ...hsl, l: Math.min(1, Math.max(0, l)) });
}

/** Lighter (positive) or darker (negative) by a lightness delta. */
function shift(hex: string, delta: number): string {
  return atLightness(hex, toHsl(hex).l + delta);
}

/** `#rrggbbaa`. CSS accepts it everywhere the six-digit form is accepted. */
function withAlpha(hex: string, a: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte}`;
}

/** WCAG relative luminance, used only to decide black-or-white foreground. */
function luminance(hex: string): number {
  const int = Number.parseInt(hex.slice(1), 16);
  const parts = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

/**
 * The six accent tokens plus a foreground for text sitting on the fill.
 *
 * Yellow and cyan accents are far too light for the white text the buttons used
 * to hardcode, so `--accent-fg` is computed rather than assumed. That is what
 * makes the custom picker safe to expose.
 */
export function accentTokens(base: string, theme: ResolvedTheme): Record<string, string> {
  // The light theme needs a slightly deeper fill: the same mid tone that reads
  // as vivid on near-black looks washed out on white.
  const fill = theme === 'dark' ? base : shift(base, -0.08);
  return {
    '--accent': fill,
    '--accent-hover': theme === 'dark' ? shift(base, 0.05) : shift(base, -0.16),
    '--accent-active': theme === 'dark' ? shift(base, -0.06) : shift(base, -0.24),
    '--accent-soft': withAlpha(base, theme === 'dark' ? 0.12 : 0.08),
    '--accent-border': withAlpha(base, theme === 'dark' ? 0.3 : 0.25),
    '--accent-text': atLightness(base, theme === 'dark' ? 0.8 : 0.4),
    '--accent-fg': luminance(fill) > 0.45 ? '#0a0a0b' : '#ffffff',
  };
}

/* --------------------------------------------------------------- appearance */

export interface Appearance {
  theme: ThemeName;
  accent: AccentName;
  customAccent: string;
  density: Density;
}

/** Row height and card padding per density. Both are consumed by the CSS. */
const DENSITY_TOKENS: Record<Density, { row: string; card: string }> = {
  compact: { row: '32px', card: '12px' },
  normal: { row: '38px', card: '16px' },
  comfortable: { row: '44px', card: '20px' },
};

export function accentColour(accent: AccentName, custom: string): string {
  if (accent === 'custom') return normaliseHex(custom) ?? DEFAULT_CUSTOM_ACCENT;
  return ACCENT_COLOURS[accent];
}

let systemQuery: MediaQueryList | null = null;
let applied: Appearance | null = null;

function prefersDark(): boolean {
  systemQuery ??= window.matchMedia('(prefers-color-scheme: dark)');
  return systemQuery.matches;
}

export function resolveTheme(theme: ThemeName): ResolvedTheme {
  if (theme === 'system') return prefersDark() ? 'dark' : 'light';
  return theme;
}

function paint(appearance: Appearance): void {
  const root = document.documentElement;
  const theme = resolveTheme(appearance.theme);

  root.dataset.theme = theme;
  // The chosen value, not the resolved one: the settings page reads it back to
  // show which segment is selected without having to re-derive it.
  root.dataset.themeChoice = appearance.theme;

  for (const [token, value] of Object.entries(
    accentTokens(accentColour(appearance.accent, appearance.customAccent), theme),
  )) {
    root.style.setProperty(token, value);
  }

  const density = DENSITY_TOKENS[appearance.density];
  root.dataset.density = appearance.density;
  root.style.setProperty('--row-h', density.row);
  root.style.setProperty('--card-pad', density.card);
}

/**
 * Paints the appearance and keeps `system` following the OS.
 *
 * Safe to call on every change: the `matchMedia` listener is attached once, and
 * it reads whatever was applied last rather than closing over a stale value.
 */
export function applyAppearance(appearance: Appearance): void {
  applied = appearance;
  paint(appearance);

  if (systemQuery && !systemListenerAttached) {
    systemQuery.addEventListener('change', () => {
      if (applied?.theme === 'system') paint(applied);
    });
    systemListenerAttached = true;
  }
}

let systemListenerAttached = false;
