/** Clipboard success is independent of whether the usage event later persists. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Continue with the local/browser fallback. */ }
  const previous = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(area);
  try {
    area.select();
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch { return false; }
  finally { area.remove(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }
}
