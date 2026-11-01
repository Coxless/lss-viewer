import type { Camera } from './camera';

/** U1: drag rotates; pinch or wheel zooms; two fingers or right drag pans. */
export function attachControls(canvas: HTMLCanvasElement, camera: Camera, onChange: () => void, onInteract: () => void) {
  const pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
  let pinch: { d: number; mx: number; my: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    camera.stopFlying();
    pinch = null;
    onInteract();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      if (p.button === 2 || p.shift) camera.pan(dx, dy, canvas.clientHeight);
      else camera.rotate(dx, dy);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinch) {
        camera.zoom(pinch.d / d);
        camera.pan(mx - pinch.mx, my - pinch.my, canvas.clientHeight);
      }
      pinch = { d, mx, my };
    }
    onChange();
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      camera.stopFlying();
      onInteract();
      camera.zoom(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
      onChange();
    },
    { passive: false },
  );
}
