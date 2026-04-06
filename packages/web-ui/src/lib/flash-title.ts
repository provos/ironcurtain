/**
 * Flash the document title to attract attention when the tab is not visible.
 * Returns a cleanup function to stop flashing.
 */

let activeCleanup: (() => void) | null = null;

export function startFlashTitle(message: string): () => void {
  // Only one flash at a time
  activeCleanup?.();

  const originalTitle = document.title;
  let showMessage = true;

  const interval = setInterval(() => {
    document.title = showMessage ? message : originalTitle;
    showMessage = !showMessage;
  }, 1000);

  function stop(): void {
    clearInterval(interval);
    document.title = originalTitle;
    document.removeEventListener('visibilitychange', onVisible);
    if (activeCleanup === stop) {
      activeCleanup = null;
    }
  }

  function onVisible(): void {
    if (!document.hidden) {
      stop();
    }
  }

  document.addEventListener('visibilitychange', onVisible);
  activeCleanup = stop;

  return stop;
}
