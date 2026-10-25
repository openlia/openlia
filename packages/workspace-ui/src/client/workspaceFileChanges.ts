type Listener = (path: string) => void;
const listeners = new Set<Listener>();

export function notifyWorkspaceFileChange(path: string) {
  for (const listener of listeners) listener(path);
}

export function subscribeWorkspaceFileChanges(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
