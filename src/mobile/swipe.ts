/* Drag-to-swipe cards (touch and mouse), ported from the MVP. transform/opacity only, one write per frame. */
export type Dir = 'left' | 'right' | 'up' | 'down';

export function attachSwipe(card: HTMLElement, stage: HTMLElement, { dirs, threshold = 90, onCommit }: { dirs: Dir[]; threshold?: number; onCommit: (dir: Dir, restore: () => void) => void }) {
  let start: { x: number; y: number } | null = null;
  let delta = { x: 0, y: 0 };
  let frame = 0;
  const cue = (active: Dir | null, strength: number) => (['left', 'right', 'up', 'down'] as Dir[]).forEach((d) => stage.style.setProperty(`--cue-${d}`, String(d === active ? strength : 0)));
  const dirOf = (dx: number, dy: number): Dir | null => {
    const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    return dirs.includes(dir) ? dir : null;
  };
  const paint = () => {
    frame = 0;
    card.style.transform = `translate3d(${delta.x}px, ${delta.y}px, 0) rotate(${delta.x / 25}deg)`;
    const dir = dirOf(delta.x, delta.y);
    cue(dir, dir ? Math.min(1, Math.hypot(delta.x, delta.y) / threshold) : 0);
  };
  const restore = () => {
    cancelAnimationFrame(frame); frame = 0;
    card.style.transition = 'transform .25s ease, opacity .25s';
    card.style.transform = ''; card.style.opacity = '';
    cue(null, 0);
  };
  const fling = (dir: Dir) => {
    cancelAnimationFrame(frame); frame = 0;
    const far = { left: [-560, 0], right: [560, 0], up: [0, -700], down: [0, 700] }[dir];
    card.style.transition = 'transform .26s ease-in, opacity .26s';
    card.style.transform = `translate3d(${far[0]}px, ${far[1]}px, 0) rotate(${far[0] / 25}deg)`;
    card.style.opacity = '0';
    cue(dir, 1);
    navigator.vibrate?.(12);
    setTimeout(() => onCommit(dir, restore), 240);
  };
  card.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, a') || e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY }; delta = { x: 0, y: 0 };
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch { /* fine */ }
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    delta = { x: e.clientX - start.x, y: e.clientY - start.y };
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  const end = (e: PointerEvent) => {
    if (!start) return;
    const dx = e.clientX - start.x; const dy = e.clientY - start.y;
    start = null;
    const dir = dirOf(dx, dy);
    if (dir && Math.hypot(dx, dy) >= threshold) fling(dir); else restore();
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', () => { start = null; restore(); });
  return { fling, restore };
}
