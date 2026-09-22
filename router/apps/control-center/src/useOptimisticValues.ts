import { useCallback, useEffect, useRef, useState } from "react";

export type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface OptimisticValues<T> {
  value(key: string, fallback: T): T;
  mutate(key: string, next: T, label: string, action: () => Promise<unknown>): Promise<void>;
  mutateMany(changes: Iterable<readonly [string, T]>, label: string, action: () => Promise<unknown>): Promise<void>;
}

// Mutations are deliberately serialized per hook. The control process writes
// durable settings, so two quick clicks must reach it in click order even
// though the switch itself responds immediately. `runAction` owns the common
// toast and refresh flow and currently reports failures without rethrowing;
// the wrapped action records whether the durable write actually succeeded so
// the optimistic value can still roll back on an error.
export function useOptimisticValues<T>(
  authoritative: ReadonlyMap<string, T>,
  runAction: RunAction,
): OptimisticValues<T> {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, T>>(() => new Map());
  const revisions = useRef(new Map<string, number>());
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    setOverrides((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, optimistic] of current) {
        if (authoritative.has(key) && Object.is(authoritative.get(key), optimistic)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [authoritative]);

  const value = useCallback((key: string, fallback: T) => (
    overrides.has(key) ? overrides.get(key)! : fallback
  ), [overrides]);

  const mutateMany = useCallback((
    changes: Iterable<readonly [string, T]>,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const desired = new Map(changes);
    if (!desired.size) return Promise.resolve();

    const mutationRevisions = new Map<string, number>();
    for (const key of desired.keys()) {
      const revision = (revisions.current.get(key) ?? 0) + 1;
      revisions.current.set(key, revision);
      mutationRevisions.set(key, revision);
    }
    setOverrides((current) => new Map([...current, ...desired]));

    const pending = queue.current.catch(() => undefined).then(async () => {
      let saved = false;
      try {
        await runAction(label, async () => {
          await action();
          saved = true;
        });
      } catch {
        // App.runAction currently owns error reporting. Keeping this guard
        // makes rollback survive if a future runner chooses to rethrow.
      }
      if (saved) return;

      setOverrides((current) => {
        const next = new Map(current);
        let changed = false;
        for (const [key, revision] of mutationRevisions) {
          if (revisions.current.get(key) !== revision) continue;
          changed = next.delete(key) || changed;
        }
        return changed ? next : current;
      });
    });
    queue.current = pending;
    return pending;
  }, [runAction]);

  const mutate = useCallback((
    key: string,
    next: T,
    label: string,
    action: () => Promise<unknown>,
  ) => mutateMany([[key, next]], label, action), [mutateMany]);

  return { value, mutate, mutateMany };
}
