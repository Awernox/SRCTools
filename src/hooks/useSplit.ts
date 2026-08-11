/**
 * Draggable split panes.
 *
 * Pointer capture rather than window listeners: the drag then survives the
 * cursor leaving the handle, and releasing outside the window still ends it.
 */

import { useCallback, useRef, useState } from 'react';

interface SplitOptions {
  /** Current position as a fraction of the container, 0–1. */
  value: number;
  onChange: (value: number) => void;
  direction?: 'horizontal' | 'vertical';
  min?: number;
  max?: number;
}

export function useSplit({
  value,
  onChange,
  direction = 'horizontal',
  min = 0.2,
  max = 0.8,
}: SplitOptions) {
  const container = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging || !container.current) return;
      const box = container.current.getBoundingClientRect();
      const fraction =
        direction === 'horizontal'
          ? (event.clientX - box.left) / box.width
          : (event.clientY - box.top) / box.height;
      if (!Number.isFinite(fraction)) return;
      onChange(Math.min(max, Math.max(min, fraction)));
    },
    [dragging, direction, min, max, onChange],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }, []);

  return {
    containerRef: container,
    dragging,
    /** Spread onto the handle element. */
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      'data-dragging': dragging,
      role: 'separator' as const,
      'aria-orientation': (direction === 'horizontal' ? 'vertical' : 'horizontal') as
        | 'vertical'
        | 'horizontal',
      tabIndex: -1,
    },
    /** Fraction, clamped, for the pane's flex-basis. */
    fraction: Math.min(max, Math.max(min, value)),
  };
}
