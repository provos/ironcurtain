import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import MatrixRain from './matrix-rain.svelte';

// ---------------------------------------------------------------------------
// Environment shims -- jsdom lacks Canvas, ResizeObserver, matchMedia,
// requestAnimationFrame, OffscreenCanvas, and document.fonts in the shapes
// this component needs.
// ---------------------------------------------------------------------------

type RafCallback = (time: number) => void;
let pendingRafs: Array<{ id: number; cb: RafCallback }> = [];
let nextRafId = 1;

function installShims() {
  pendingRafs = [];
  nextRafId = 1;

  // Remove OffscreenCanvas to force the layout module into DOM canvas path.
  // @ts-expect-error -- removing OffscreenCanvas
  delete globalThis.OffscreenCanvas;

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  // matchMedia stub: returns a MediaQueryList-shaped object that never matches.
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );

  // RAF stub -- synchronous-enqueue; drain manually via `drainRaf()`.
  vi.stubGlobal('requestAnimationFrame', (cb: RafCallback) => {
    const id = nextRafId++;
    pendingRafs.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingRafs = pendingRafs.filter((r) => r.id !== id);
  });

  // Mock canvas context that supports both the renderer's needs and the
  // layout module's offscreen text rendering + pixel sampling.
  const makeStubContext = () => {
    let canvasWidth = 1;
    let canvasHeight = 1;

    return {
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      globalAlpha: 1,
      fillStyle: '#000',
      font: '',
      textBaseline: 'top',
      textAlign: 'center',
      shadowBlur: 0,
      shadowColor: 'transparent',
      canvas: {
        get width() {
          return canvasWidth;
        },
        set width(w: number) {
          canvasWidth = w;
        },
        get height() {
          return canvasHeight;
        },
        set height(h: number) {
          canvasHeight = h;
        },
      },
      measureText(_text: string) {
        return {
          width: 600,
          actualBoundingBoxAscent: 80,
          actualBoundingBoxDescent: 20,
        };
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        const size = w * h * 4;
        const data = new Uint8ClampedArray(size);
        // Fill all pixels to simulate text rendering.
        for (let i = 0; i < size; i += 4) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = 255;
        }
        return { data, width: w, height: h };
      },
    } as unknown as CanvasRenderingContext2D;
  };

  // @ts-expect-error -- installing a stub on the prototype
  HTMLCanvasElement.prototype.getContext = vi.fn(() => makeStubContext());

  // jsdom returns 0x0 for getBoundingClientRect on every element. Stub the
  // prototype so the component's initial measure returns a usable viewport.
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 900,
        right: 1440,
        width: 1440,
        height: 900,
        toJSON: () => ({}),
      }) as DOMRect,
  );

  // document.fonts stub -- font loading resolves immediately in tests.
  Object.defineProperty(document, 'fonts', {
    value: {
      load: vi.fn().mockResolvedValue([]),
      ready: Promise.resolve(),
    },
    writable: true,
    configurable: true,
  });
}

/** Drain one round of pending RAF callbacks. */
function drainRaf(now = 16) {
  const batch = pendingRafs;
  pendingRafs = [];
  for (const r of batch) r.cb(now);
}

/** Flush microtask queue (for Svelte $effect + font loading promises). */
async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installShims();
});

afterEach(() => {
  vi.unstubAllGlobals();
  pendingRafs = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MatrixRain', () => {
  it('mounts and renders two canvas elements inside a container div', () => {
    const { container } = render(MatrixRain, { props: { class: 'test-class' } });
    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    // The container div should carry the passthrough class.
    const wrapper = canvases[0]?.parentElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper?.classList.contains('test-class')).toBe(true);
  });

  it('wordmark canvas has the wordmark-glow class and pointer-events-none', () => {
    const { container } = render(MatrixRain, { props: {} });
    const canvases = container.querySelectorAll('canvas');
    // Second canvas is the wordmark canvas (later in DOM = on top).
    const wordmarkCanvas = canvases[1];
    expect(wordmarkCanvas).toBeTruthy();
    expect(wordmarkCanvas?.classList.contains('wordmark-glow')).toBe(true);
    expect(wordmarkCanvas?.classList.contains('pointer-events-none')).toBe(true);
  });

  it('unmounts cleanly without throwing', async () => {
    const { unmount } = render(MatrixRain, { props: {} });
    await flush();
    drainRaf();
    expect(() => unmount()).not.toThrow();
  });

  it('fires onready after the engine reports wordmarkReady (reduced motion)', async () => {
    const onready = vi.fn();
    render(MatrixRain, { props: { reducedMotion: true, onready } });
    // Wait for font loading promise to resolve + effects to run.
    await flush();
    drainRaf();
    drainRaf();
    expect(onready).toHaveBeenCalledTimes(1);
  });

  it('does not fire onready in full-motion mode on the very first frame', async () => {
    const onready = vi.fn();
    render(MatrixRain, { props: { reducedMotion: false, onready } });
    await flush();
    drainRaf();
    // First frame of assembly -- wordmark is not yet ready, so onready stays silent.
    expect(onready).not.toHaveBeenCalled();
  });
});
