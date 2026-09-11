type DirectChildCountProvider = (() => number) | null;
type DirectChildCountObserver = ((count: number) => void) | null;

const PROVIDER_KEY = Symbol.for("pi-interactive-subagents.direct-child-count-provider.v1");
const OBSERVER_KEY = Symbol.for("pi-interactive-subagents.direct-child-count-observer.v1");

type GlobalWithOwnership = typeof globalThis & {
  [PROVIDER_KEY]?: DirectChildCountProvider;
  [OBSERVER_KEY]?: DirectChildCountObserver;
};

export function setDirectChildCountProvider(provider: DirectChildCountProvider): void {
  (globalThis as GlobalWithOwnership)[PROVIDER_KEY] = provider;
}

export function setDirectChildCountObserver(observer: DirectChildCountObserver): void {
  (globalThis as GlobalWithOwnership)[OBSERVER_KEY] = observer;
}

export function getDirectChildCount(): number {
  const provider = (globalThis as GlobalWithOwnership)[PROVIDER_KEY];
  if (!provider) return 0;
  const count = provider();
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function notifyDirectChildCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return;
  (globalThis as GlobalWithOwnership)[OBSERVER_KEY]?.(count);
}
