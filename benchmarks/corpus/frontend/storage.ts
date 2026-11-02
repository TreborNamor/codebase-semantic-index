export function loadPreferences(key: string, defaults: object): object {
  // A damaged browser value must not prevent the application from starting.
  try { return {...defaults, ...JSON.parse(localStorage.getItem(key) ?? '{}')}; }
  catch { return defaults; }
}

export function savePreferences(key: string, value: object): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; } // Storage quota or browser privacy restrictions.
}

export function synchronizeTabs(key: string, receive: (value: unknown) => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === key && event.newValue) receive(JSON.parse(event.newValue));
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
