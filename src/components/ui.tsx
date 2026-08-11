/**
 * Shared primitives.
 *
 * Every one of these is a thin wrapper over the classes in `components.css`;
 * none of them own colour or spacing values. The point is that a badge meaning
 * "we could not check this" looks identical everywhere it appears.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ABSENT, type Tone } from '../format';
import { bindingKeys } from '../shortcuts';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'badge--ok',
  warn: 'badge--warn',
  danger: 'badge--danger',
  unknown: 'badge--unknown',
  info: 'badge--info',
  accent: 'badge--accent',
  neutral: 'badge--neutral',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  small = false,
  outline = false,
  title,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  small?: boolean;
  outline?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const classes = ['badge', outline ? 'badge--outline' : TONE_CLASS[tone]];
  if (small) classes.push('badge--sm');
  return (
    <span className={classes.join(' ')} title={title}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

/** A single key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Renders a stored binding such as `ctrl+shift+a` or the sequence `g d`. */
export function KeyHint({ binding }: { binding: string }) {
  const keys = bindingKeys(binding);
  if (keys.length === 0) return null;
  return (
    <span className="kbd-row">
      {keys.map((key, i) => (
        <Kbd key={`${key}-${i}`}>{key}</Kbd>
      ))}
    </span>
  );
}

export function Spinner({ size = 'sm', accent = false }: { size?: 'sm' | 'lg'; accent?: boolean }) {
  const classes = ['spinner'];
  if (size === 'lg') classes.push('spinner--lg');
  if (accent) classes.push('spinner--accent');
  return <span className={classes.join(' ')} role="status" aria-label="Loading" />;
}

export function Skeleton({
  width = '100%',
  height = 12,
  radius,
}: {
  width?: string | number;
  height?: string | number;
  radius?: number;
}) {
  return (
    <span
      className="skeleton"
      style={{
        display: 'block',
        width,
        height,
        ...(radius === undefined ? {} : { borderRadius: radius }),
      }}
    />
  );
}

/**
 * The em dash for data Speedrun.com did not give us.
 *
 * A component rather than a bare string so that "absent" is impossible to
 * confuse with a zero, an empty string or a formatting bug.
 */
export function Absent({ title = 'Speedrun.com did not provide this' }: { title?: string }) {
  return (
    <span className="absent" title={title} aria-label="Not provided">
      {ABSENT}
    </span>
  );
}

/** Renders `value`, or the absent marker when it is null, undefined or blank. */
export function Maybe({ value, title }: { value: string | null | undefined; title?: string }) {
  if (value === null || value === undefined || value.trim() === '') return <Absent title={title} />;
  return <>{value}</>;
}

/* ------------------------------------------------------------------ tooltip */

interface TooltipProps {
  label: ReactNode;
  /** Second line, for the "what this does and does not assert" copy. */
  detail?: ReactNode;
  side?: 'top' | 'bottom';
  children: ReactNode;
}

/**
 * Hover explanation.
 *
 * Positioned through a portal against the viewport rather than the parent, so a
 * tooltip inside a scrolling table is not clipped by its overflow.
 */
export function Tooltip({ label, detail, side = 'top', children }: TooltipProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const target = anchor.current.getBoundingClientRect();
    const tip = bubble.current.getBoundingClientRect();
    const gap = 6;
    let top = side === 'top' ? target.top - tip.height - gap : target.bottom + gap;
    // Flip rather than run off the top of the window.
    if (top < 4) top = target.bottom + gap;
    if (top + tip.height > window.innerHeight - 4) top = target.top - tip.height - gap;
    const left = Math.min(
      Math.max(4, target.left + target.width / 2 - tip.width / 2),
      window.innerWidth - tip.width - 4,
    );
    setPos({ left, top });
  }, [open, side, label, detail]);

  return (
    <>
      <span
        ref={anchor}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div className="tooltip" ref={bubble} style={{ left: pos.left, top: pos.top }} role="tooltip">
            <div className="tooltip__label">{label}</div>
            {detail !== undefined && <div className="tooltip__sub">{detail}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------------------------------------------- states */

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {hint && <div className="empty__hint">{hint}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/**
 * A failed load.
 *
 * Always offers the retry, because most failures here are transient network
 * trouble rather than anything the moderator did.
 */
export function ErrorState({
  title = 'Could not load this',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty__title" style={{ color: 'var(--danger-text)' }}>
        {title}
      </div>
      <div className="empty__hint" data-selectable>
        {message}
      </div>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry} style={{ marginTop: 8 }}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  style,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="card" style={style}>
      {(title !== undefined || actions !== undefined) && (
        <header className="card__title">
          {icon}
          <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------- segmented */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- tabs */

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          className={`tabs__tab${tab.value === value ? ' tabs__tab--active' : ''}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="dim"> {tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- checkbox */

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: string;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  // `indeterminate` has no attribute form; it must be set on the element.
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate === true && !checked;
  }, [indeterminate, checked]);

  return (
    <label
      style={{
        display: 'flex',
        alignItems: hint ? 'flex-start' : 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        minWidth: 0,
      }}
    >
      <input
        ref={ref}
        type="checkbox"
        className="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        style={hint ? { marginTop: 2 } : undefined}
      />
      {label !== undefined && (
        <span style={{ minWidth: 0 }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>{label}</span>
          {hint && (
            <span className="dim" style={{ display: 'block', fontSize: 'var(--text-xs)', lineHeight: 1.45 }}>
              {hint}
            </span>
          )}
        </span>
      )}
    </label>
  );
}

/* --------------------------------------------------------------- progress */

export function ProgressBar({
  value,
  max,
  tone = 'accent',
}: {
  value: number;
  max: number;
  tone?: 'accent' | 'ok' | 'warn' | 'danger';
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const colour =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--accent)';
  return (
    <div
      style={{
        height: 5,
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-active)',
        overflow: 'hidden',
      }}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: colour,
          transition: 'width var(--normal) var(--ease)',
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------- context menu */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Rendered right-aligned, for a shortcut hint. */
  hint?: string;
}

export type MenuEntry = MenuItem | { separator: true } | { heading: string };

/**
 * Right-click menu, positioned at the cursor.
 *
 * Closes on an outside click, on Escape and on scroll — a menu that lingers over
 * content that has moved would fire on the wrong row.
 *
 * The dismiss listener runs in the capture phase, so it sees the press before
 * anything underneath does. That means it must decide for itself whether the
 * press was inside the menu: closing unconditionally would unmount the button
 * between `mousedown` and `click`, and the click would land on whatever the
 * portal had been covering. That is exactly what made every entry here
 * unclickable.
 */
export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const box = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - box.width - 6),
      top: Math.min(y, window.innerHeight - box.height - 6),
    });
  }, [x, y, entries.length]);

  useLayoutEffect(() => {
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Scrolling always dismisses: the row the menu belongs to has moved out
    // from under it, so there is nothing left to be right about.
    const dismiss = () => onClose();

    window.addEventListener('mousedown', outside, true);
    window.addEventListener('wheel', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('wheel', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      // A second right-click inside the menu would otherwise re-open the row's
      // menu underneath it at a new position.
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if ('separator' in entry) return <div className="menu__separator" key={`sep-${index}`} />;
        if ('heading' in entry)
          return (
            <div className="menu__label" key={`head-${index}`}>
              {entry.heading}
            </div>
          );
        return (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className="menu__item"
            data-danger={entry.danger === true}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon}
            <span style={{ flex: 1, minWidth: 0 }}>{entry.label}</span>
            {entry.hint && <KeyHint binding={entry.hint} />}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Cursor position plus entries, or `null` when no menu is open. */
export interface MenuAnchor {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/* -------------------------------------------------------------- modal */

export function Modal({
  title,
  onClose,
  footer,
  width,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Focus inside the dialog so Tab cycles here and Escape lands on the
    // handler above rather than on whatever had focus before.
    box.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        ref={box}
        role="dialog"
        aria-modal="true"
        style={width === undefined ? undefined : { width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
