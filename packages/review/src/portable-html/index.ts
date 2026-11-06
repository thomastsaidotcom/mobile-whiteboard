import { type ReviewReader, collectReview } from "./collect.js";
import { renderReview } from "./render.js";

/** Read one saved snapshot and its frozen sources; the returned HTML works offline. */
export async function exportReviewHtml(
  reader: ReviewReader,
  reviewId: string,
  version?: number,
): Promise<string> {
  return renderReview(await collectReview(reader, reviewId, version));
}
