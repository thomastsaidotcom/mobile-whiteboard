import {
  ReviewApiClient,
  ReviewDiffFileSchema,
} from "@dev.fast/review-protocol";
import {
  blockSchema,
  pinsSchema,
  reviewTargetSchema,
} from "@review/review-api/document";
import { z } from "zod";

const versionSchema = z.number().int().nonnegative();

const identity = z.string().min(1);

const pins = pinsSchema.extend({ worktreeRevision: identity.optional() });

export const summarySchema = z.object({
  reviewId: identity,
  title: z.string(),
  version: versionSchema,
  createdAt: z.iso.datetime({ offset: true }),
  pins: pins.optional(),
  target: reviewTargetSchema.optional(),
});

export const snapshotSchema = summarySchema.extend({
  document: z.array(blockSchema),
  kind: z.literal("scratchpad").optional(),
  sourceUnavailable: z.boolean().optional(),
  staleSources: z.array(z.string()).optional(),
  origin: z
    .object({
      branch: z.string().optional(),
      baseRef: z.string().optional(),
      baseBranch: z.string().optional(),
      pullRequestNumber: z.number().int().positive().optional(),
      pullRequestUrl: z.string().optional(),
      pullRequestTitle: z.string().optional(),
      revision: z.string().optional(),
    })
    .optional(),
});

export type ReviewSnapshot = z.infer<typeof snapshotSchema>;

export type Side = "base" | "head";

export const fileSchema = z.object({
  file: identity,
  side: z.enum(["base", "head"]),
  commit: identity,
  text: z.string(),
});

const treeSchema = z.array(
  z.object({ path: identity, kind: z.enum(["directory", "file"]) }),
);

export function mapSafeReviewRequest(
  input: string | URL,
  init: RequestInit = {},
  origin: string = location.origin,
) {
  const url = new URL(input, origin);

  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (init.method ?? "GET").toUpperCase() !== "GET"
  )
    throw new Error("Only same-origin review reads are available.");
  url.pathname = url.pathname.replace(/^\/reviews-api(?=\/|$)/, "/api/reviews");

  if (
    !/^\/api\/reviews(?:\/[^/]+(?:\/(?:tree|file|diff|commits|history|resources\/[^/]+|maps\/[^/]+))?)?\/?$/.test(
      url.pathname,
    )
  )
    throw new Error("This review endpoint is unavailable on mobile.");

  if (url.searchParams.has("token"))
    throw new Error("Tokens are not accepted by the phone UI.");
  url.searchParams.delete("full");
  const headers = new Headers(init.headers);
  headers.delete("x-review-token");
  headers.delete("authorization");

  return {
    url: url.href,
    init: {
      ...init,
      method: "GET",
      headers,
      credentials: "same-origin" as const,
      redirect: "error" as const,
    },
  };
}

export async function mobileRequest(input: string | URL, init?: RequestInit) {
  const mapped = mapSafeReviewRequest(input, init);

  return fetch(mapped.url, mapped.init);
}

export function createMobileReviewApiClient() {
  return new ReviewApiClient(
    { serverUrl: location.origin, token: "" },
    mobileRequest,
  );
}

async function errorMessage(response: Response) {
  const text = (await response.text()).trim();

  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body: unknown = JSON.parse(text);
      const error = z.object({ error: z.string() }).safeParse(body);

      if (error.success) return error.data.error.slice(0, 300);
    } catch {
      /* A malformed error body is still useful as plain text. */
    }
  }

  return text.slice(0, 300) || `Request failed (${response.status}).`;
}

export function reviewUrl(
  id: string,
  endpoint = "",
  params: Record<string, string | number | undefined> = {},
) {
  const url = new URL(
    `/api/reviews/${encodeURIComponent(id)}${endpoint}`,
    location.origin,
  );

  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, String(value));

  return url.href;
}

async function read<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await mobileRequest(url);

  if (!response.ok) throw new Error(await errorMessage(response));

  return schema.parse(await response.json());
}

export const fetchReviewsList = () =>
  read("/api/reviews", z.array(summarySchema));

export const fetchReviewSnapshot = async (id: string, version?: number) => {
  const snapshot = await read(reviewUrl(id, "", { version }), snapshotSchema);

  if (
    snapshot.reviewId !== id ||
    (version !== undefined && snapshot.version !== version)
  )
    throw new Error("Snapshot does not match the requested review/version.");

  return snapshot;
};

export const fetchReviewTree = (
  id: string,
  path: string,
  side: Side,
  version: number,
) => read(reviewUrl(id, "/tree", { path, side, version }), treeSchema);

export const fetchReviewFile = async (
  id: string,
  options: {
    file: string;
    side: Side;
    version: number;
    repositoryId?: string;
    head?: string;
    base?: string;
  },
) => {
  const file = await read(reviewUrl(id, "/file", options), fileSchema);

  if (file.file !== options.file || file.side !== options.side)
    throw new Error("Source response does not match the requested file.");

  return file;
};

export const fetchReviewDiff = (id: string, version: number) =>
  read(reviewUrl(id, "/diff", { version }), z.array(ReviewDiffFileSchema));

export type SaveResult =
  | { state: "saved"; version: number }
  | { state: "conflict" | "unknown" | "failed"; message: string };

export async function saveMarkdownBlock(
  id: string,
  blockId: string,
  payload: { version: number; markdown: string },
): Promise<SaveResult> {
  try {
    const response = await fetch(
      reviewUrl(id, `/markdown/${encodeURIComponent(blockId)}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
        credentials: "same-origin",
        redirect: "error",
      },
    );

    if (!response.ok)
      return {
        state:
          response.status === 409
            ? "conflict"
            : response.status >= 500
              ? "unknown"
              : "failed",
        message: await errorMessage(response),
      };

    const result = z
      .object({
        reviewId: identity,
        version: versionSchema,
        targetId: identity.optional(),
      })
      .parse(await response.json());

    if (
      result.reviewId !== id ||
      result.version < payload.version ||
      (result.targetId !== undefined && result.targetId !== blockId)
    )
      throw new Error("Save acknowledgement does not match this draft.");

    return { state: "saved", version: result.version };
  } catch {
    return {
      state: "unknown",
      message:
        "Save outcome unknown. Your draft is kept. Reread the review and compare before saving again.",
    };
  }
}
