import {
  type Block,
  anchorPins,
  checkReferences,
  documentSchema,
  elements,
  pinsSchema,
  reviewTargetSchema,
  sourceReferences,
} from "@review/review-api/document.js";
import {
  checkSourcePath,
  fileLineRangeSchema,
  requireVisibleSource,
  sliceSourceRange,
} from "@review/source.js";
import { z } from "zod";

export interface ReviewReader {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Untrusted API transport; each response is parsed immediately with its boundary schema.
  read(route: string): Promise<unknown>;
}

const snapshotSchema = z.object({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string(),
  document: documentSchema,
  pins: pinsSchema.optional(),
  target: reviewTargetSchema.optional(),
  sourceUnavailable: z.boolean().optional(),
  worktreeRevision: z.never().optional(),
});

const commit = z
  .string()
  .regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    "Portable source needs a full immutable commit ID.",
  );

const fileSchema = z.object({
  repositoryId: z.string().optional(),
  file: z.string(),
  side: z.enum(["base", "head"]),
  commit,
  text: z
    .string()
    .refine((text) => !text.includes("\0"), "Binary source cannot be quoted."),
});

const summarySchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.literal(true).optional(),
});

export function supportedDocument(document: Block[]): Block[] {
  return document.flatMap<Block>((block) => {
    if (
      ["sequence", "database_lens", "image", "software_map"].includes(
        block.type,
      )
    )
      return [];

    if (block.type === "section" || block.type === "callout")
      return [{ ...block, children: supportedDocument(block.children) }];

    return [block];
  });
}

export async function collectReview(
  reader: ReviewReader,
  reviewId: string,
  version?: number,
) {
  if (!reviewId.trim()) throw new Error("A saved review ID is required.");

  if (version !== undefined) z.number().int().nonnegative().parse(version);
  const route = `/${encodeURIComponent(reviewId)}`;

  const snapshot = snapshotSchema.parse(
    await reader.read(
      `${route}?full=true${version === undefined ? "" : `&version=${version}`}`,
    ),
  );

  if (
    snapshot.reviewId !== reviewId ||
    (version !== undefined && version !== snapshot.version)
  )
    throw new Error("Saved review identity/version mismatch.");

  if (snapshot.target?.kind === "worktree" || snapshot.sourceUnavailable)
    throw new Error(
      "Portable export requires available saved commit sources; worktree targets are unsupported.",
    );

  if (snapshot.target?.kind === "commits") {
    commit.parse(snapshot.target.head);

    if (snapshot.target.base) commit.parse(snapshot.target.base);

    if (
      snapshot.target.head !== snapshot.pins?.head ||
      (snapshot.target.base ?? snapshot.target.head) !== snapshot.pins?.base
    )
      throw new Error("Review target commits do not match frozen pins.");
  }

  checkReferences(snapshot.document);

  for (const block of elements(snapshot.document)) {
    if (block.type !== "call_stack_diff") continue;

    for (const side of ["base", "head"] as const)
      block[side].forEach((frame, index) => {
        frame.id = `frame-${side}-${index}`;
      });
  }

  const comparisons = new Map<string, ReturnType<typeof anchorPins>>();

  const checkPins = (pins: ReturnType<typeof anchorPins>) => {
    commit.parse(pins.base);
    commit.parse(pins.head);
    comparisons.set(JSON.stringify(pins), pins);

    return pins;
  };

  if (snapshot.pins) checkPins(snapshot.pins);

  if (
    snapshot.target &&
    (!snapshot.pins ||
      snapshot.target.repositoryId !== snapshot.pins.repositoryId)
  )
    throw new Error("Review target repository does not match its frozen pins.");

  const query = (pins: ReturnType<typeof anchorPins>) =>
    new URLSearchParams({ version: String(snapshot.version), ...pins });

  const sources = [];

  const leaves = (document: Block[]): Block[] =>
    document.flatMap((block) =>
      block.type === "section" || block.type === "callout"
        ? leaves(block.children)
        : [block],
    );

  for (const owner of leaves(supportedDocument(snapshot.document))) {
    for (const ref of sourceReferences([owner])) {
      const range = fileLineRangeSchema.parse(ref.source);
      checkSourcePath(range.file);
      const pins = checkPins(anchorPins(range, snapshot.pins));
      const params = query(pins);
      params.set("file", range.file);
      params.set("side", range.side);

      const file = fileSchema.parse(
        await reader.read(`${route}/file?${params}`).catch((error) => {
          throw new Error(
            `Source ${range.side}/${range.file} (${ref.id}): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }),
      );

      if (
        (file.repositoryId !== undefined &&
          file.repositoryId !== pins.repositoryId) ||
        file.file !== range.file ||
        file.side !== range.side ||
        file.commit !== pins[range.side]
      )
        throw new Error(
          `Source identity mismatch for ${range.file} (${ref.id}).`,
        );
      const text = sliceSourceRange(file.text, range);

      if (ref.peek) requireVisibleSource(text, range);
      sources.push({
        ...ref,
        owner,
        source: range,
        pins,
        text,
      });
    }
  }

  const changes = [];

  for (const pins of comparisons.values()) {
    const params = query(pins);

    const files = z
      .array(summarySchema)
      .parse(await reader.read(`${route}/diff?${params}`));

    for (const file of files) {
      checkSourcePath(file.path);

      if (file.previousPath) checkSourcePath(file.previousPath);
      params.set("file", file.path);

      if (file.previousPath) params.set("previousPath", file.previousPath);
      else params.delete("previousPath");

      const patch = z
        .string()
        .parse(await reader.read(`${route}/diff?${params}`));

      changes.push({ ...file, pins, patch });
    }
  }

  return { snapshot, sources, changes };
}

export type CollectedReview = Awaited<ReturnType<typeof collectReview>>;
