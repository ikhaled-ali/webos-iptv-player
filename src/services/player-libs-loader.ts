let pending: Promise<void> | null = null;

export function loadPlayerLibraries(): Promise<void> {
  const scope = window as unknown as Record<string, unknown>;
  if (scope.__Hls && scope.__mpegts) return Promise.resolve();
  if (pending) return pending;
  const script = document.createElement('script');
  script.src = 'js/player-libs.js';
  script.async = true;
  const loading = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Player libraries timed out')), 10000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.parentNode?.removeChild(script); reject(error); }
      else resolve();
    };
    script.onload = () => finish(scope.__Hls && scope.__mpegts
      ? undefined : new Error('Player libraries are unavailable'));
    script.onerror = () => finish(new Error('Player libraries failed to load'));
    document.head.appendChild(script);
  });
  pending = loading.catch(error => { pending = null; throw error; });
  return pending;
}
