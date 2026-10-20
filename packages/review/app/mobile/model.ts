import { z } from "zod";

export const draftSchema = z.object({
  version: z.number().int().nonnegative(),
  original: z.string(),
  markdown: z.string(),
  state: z.enum(["editing", "saving", "conflict", "unknown", "failed"]),
  message: z.string(),
});

export type Draft = z.infer<typeof draftSchema>;

export const draftKey = (reviewId: string, blockId: string) =>
  `mobile-draft:${reviewId}:${blockId}`;

export function restoreDraft(
  storage: Pick<Storage, "getItem">,
  key: string,
): Draft | undefined {
  const raw = storage.getItem(key);

  if (raw === null) return undefined;
  const draft = draftSchema.parse(JSON.parse(raw));

  if (draft.state === "editing" && draft.markdown === draft.original)
    return undefined;

  return draft.state === "saving"
    ? {
        ...draft,
        state: "unknown",
        message:
          "The page closed during save. Reread and compare before retrying.",
      }
    : draft;
}

export const draftIsStale = (
  draft: Draft,
  version: number,
  markdown: string | undefined,
) => draft.version !== version || draft.original !== markdown;

interface DraftEntry {
  draft?: Draft;
  error?: string;
  message?: string;
  unreadable: boolean;
  unpersisted: boolean;
}

export function createDraftStore(storage: () => Storage) {
  const entries = new Map<string, DraftEntry>();
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of listeners) listener();
  };

  const read = (key: string): DraftEntry => {
    const cached = entries.get(key);

    if (cached) return cached;
    let entry: DraftEntry;
    let raw: string | null;

    try {
      raw = storage().getItem(key);
    } catch {
      entry = {
        error:
          "Browser storage is unavailable. Drafts stay in memory while this page is open.",
        unreadable: false,
        unpersisted: true,
      };
      entries.set(key, entry);

      return entry;
    }

    try {
      entry = {
        draft: restoreDraft({ getItem: () => raw }, key),
        unreadable: false,
        unpersisted: false,
      };
    } catch {
      entry = {
        error:
          "Stored draft could not be read. Discard it explicitly to edit this block. The stored value is untouched.",
        unreadable: true,
        unpersisted: false,
      };
    }

    entries.set(key, entry);

    return entry;
  };

  return {
    read,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    write(key: string, draft: Draft) {
      if (read(key).unreadable) return;
      let entry: DraftEntry = { draft, unreadable: false, unpersisted: false };

      try {
        storage().setItem(key, JSON.stringify(draft));
      } catch {
        entry = {
          draft,
          unreadable: false,
          unpersisted: true,
          error:
            "Browser storage failed. Your draft stays in memory while this page is open. You can save it or copy it before leaving.",
        };
      }

      entries.set(key, entry);
      changed();
    },
    acknowledge(key: string, version: number) {
      const entry: DraftEntry = {
        message: `Saved version ${version}.`,
        unreadable: false,
        unpersisted: false,
      };

      try {
        storage().removeItem(key);
      } catch {
        entry.error =
          "Saved on the Mac, but the old browser draft could not be removed. Reread and compare if it reappears after refresh.";
      }

      entries.set(key, entry);
      changed();
    },
    discard(key: string) {
      try {
        storage().removeItem(key);
      } catch {
        entries.set(key, {
          ...read(key),
          error: "Could not discard the stored draft. Its text is still kept.",
        });
        changed();

        return false;
      }

      entries.set(key, { unreadable: false, unpersisted: false });
      changed();

      return true;
    },
    blockIds(reviewId: string) {
      const prefix = draftKey(reviewId, "");
      const keys = new Set(entries.keys());

      try {
        const saved = storage();

        for (let index = 0; index < saved.length; index++) {
          const key = saved.key(index);

          if (key) keys.add(key);
        }
      } catch {
        /* In-memory drafts remain available when browser storage is blocked. */
      }

      return [...keys].flatMap((key) =>
        key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
      );
    },
    hasUnpersisted() {
      return [...entries.values()].some(
        (entry) =>
          entry.unpersisted &&
          entry.draft &&
          (entry.draft.markdown !== entry.draft.original ||
            entry.draft.state === "saving" ||
            entry.draft.state === "unknown"),
      );
    },
  };
}
