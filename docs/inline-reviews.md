# Inline saved reviews

With the selected Whiteboard Desktop already running:

```sh
whiteboard-html <session-id> --out /tmp/review.html
whiteboard-html <session-id> --version 3 > /tmp/review-v3.html
```

For an already-running headless server, set `DEV_REVIEW_SERVER_DIR` to its state directory. Export never starts a service, opens Desktop or a browser, uploads a share, or edits the review. Without `--out`, stdout contains only HTML. Errors go to stderr. Failed exports preserve an existing output file.

The collector freezes one saved version and reads exact committed sources, including reference-specific repositories and pins. Worktree targets and moving revisions are rejected. The output contains referenced excerpts, file-change summaries and real unified patches, and works without the service afterward. It can contain sensitive authored or source text, so treat it as review content.

For T3 chat, read the **complete file contents** and pass that HTML string verbatim to `html_preview`, then `html_render`. A file path alone does not display the reader. Preview narrow and wide widths and both themes. Export rejects complete output above 480,000 characters; split a large review into smaller saved reviews. Ask the agent for a fresh export after edits.

Sections use native disclosures; source links lead to included numbered excerpts. Flow connections explicitly preserve branches and cycles. Call paths are separate from source patches. Sequence, database lens, image and software-map blocks show notices in their original positions. Trace quotes are unverified; cross-side code alignment and special Markdown constructs are marked partial. The header counts partial/unavailable content. Interactive Diff lenses, rich math and automatic splitting remain follow-up work. Automated browser checks do not establish physical-phone acceptance.
