// Providers serve posters up to 2000x3000. The TV decodes one in about
// 450 ms and drops the decoded copy once its view hides, so each return to
// a section decoded every poster again. After a large poster first loads,
// a tile-sized copy is made off the main thread and later renders use it.

const THUMB_WIDTH = 264; // the 220px tile, grown 1.1x when focused, with margin
const MAX_THUMBS = 400;
const MAX_IN_FLIGHT = 2;

const thumbs = new Map<string, string>();
const pending = new Set<string>();
const queue: string[] = [];
let inFlight = 0;
let disabled = typeof createImageBitmap !== 'function' || typeof URL.createObjectURL !== 'function';

export function posterThumb(src: string): string | null {
  const url = thumbs.get(src);
  if (!url) return null;
  // Least recently used goes first.
  thumbs.delete(src);
  thumbs.set(src, url);
  return url;
}

// A loaded poster wider than its thumbnail gets one.
export function requestPosterThumb(src: string, naturalWidth: number): void {
  if (disabled || naturalWidth <= THUMB_WIDTH * 1.5 || !/^https?:/i.test(src)) return;
  if (thumbs.has(src) || pending.has(src)) return;
  pending.add(src);
  queue.push(src);
  pump();
}

function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const src = queue.shift()!;
    inFlight++;
    void makeThumb(src)
      .then((url) => {
        if (url) store(src, url);
      }, () => {
        // A host without CORS fails every fetch (the desktop preview); the TV
        // app's origin may fetch any host.
        disabled = true;
        queue.length = 0;
      })
      .then(() => {
        pending.delete(src);
        inFlight--;
        pump();
      });
  }
}

async function makeThumb(src: string): Promise<string | null> {
  const response = await fetch(src);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), {
    resizeWidth: THUMB_WIDTH,
    resizeQuality: 'medium',
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}

function store(src: string, url: string): void {
  thumbs.set(src, url);
  if (thumbs.size > MAX_THUMBS) {
    const [oldest, oldUrl] = thumbs.entries().next().value as [string, string];
    thumbs.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
  swapSoon();
}

// Tiles already drawn take their thumbnails too: a section shown again keeps
// its tiles rather than re-rendering them.
let swapFrame: number | null = null;
function swapSoon(): void {
  if (swapFrame !== null) return;
  swapFrame = requestAnimationFrame(() => {
    swapFrame = null;
    document.querySelectorAll<HTMLImageElement>('img[data-thumb]').forEach((img) => {
      const url = thumbs.get(img.getAttribute('data-art') ?? '');
      if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
    });
  });
}
