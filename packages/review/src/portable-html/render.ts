import {
  type MarkdownNode,
  markdownNodes,
  markdownText,
  parseMarkdown,
} from "@review/markdown.js";
import type { Block } from "@review/review-api/document.js";

import type { CollectedReview } from "./collect.js";

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

function code(text: string, first = 1): string {
  return `<pre tabindex="0" aria-label="Scrollable code"><code>${text
    .split("\n")
    .map(
      (line, index) =>
        `<span class="line"><span class="number" aria-hidden="true">${first + index}</span>${escape(line)}</span>`,
    )
    .join("\n")}</code></pre>`;
}

/** No network, host services or authored HTML enter this renderer. */
export function renderReview({
  snapshot,
  sources,
  changes,
}: CollectedReview): string {
  const partial = new Set<Block>();
  let serial = 0;
  const headingIds = new Map<MarkdownNode, string>();
  const anchors = new Map<string, string>();
  const trees = new Map<Block, MarkdownNode>();

  const prepare = (document: Block[]) => {
    for (const block of document) {
      if (block.type === "section" || block.type === "callout")
        prepare(block.children);

      if (block.type !== "markdown") continue;
      const tree = parseMarkdown(block.markdown);
      trees.set(block, tree);

      for (const node of markdownNodes(tree))
        if (node.type === "heading") {
          const id = `heading-${serial++}`;
          headingIds.set(node, id);

          const slug = markdownText(node)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, "")
            .replace(/\s+/g, "-");

          if (!anchors.has(slug)) anchors.set(slug, id);
        }
    }
  };

  prepare(snapshot.document);

  const sourceId = (source: CollectedReview["sources"][number]) =>
    `source-${sources.indexOf(source)}`;

  const sourceLinks = (owner: Block, id?: string) =>
    sources
      .filter(
        (source) =>
          source.owner === owner && (id === undefined || source.id === id),
      )
      .map(
        (source) =>
          `<a href="#${sourceId(source)}">${escape(source.label ?? `${source.source.side}/${source.source.file}:${source.source.fromLine}–${source.source.toLine}`)}</a>`,
      )
      .join(" · ");

  const markdown = (node: MarkdownNode, owner: Block): string => {
    const children = () =>
      (node.children ?? []).map((child) => markdown(child, owner)).join("");

    switch (node.type) {
      case "root":
        return children();
      case "heading":
        return `<h${node.depth} id="${headingIds.get(node)}">${children()}</h${node.depth}>`;
      case "paragraph":
        return `<p>${children()}</p>`;
      case "text":
      case "html":
        return escape(node.value ?? "");
      case "strong":
        return `<strong>${children()}</strong>`;
      case "emphasis":
        return `<em>${children()}</em>`;
      case "delete":
        return `<del>${children()}</del>`;
      case "inlineCode":
        return `<code>${escape(node.value ?? "")}</code>`;
      case "code":
        return `<p>${escape(node.lang ?? "text")}</p>${code(node.value ?? "")}`;
      case "blockquote":
        return `<blockquote>${children()}</blockquote>`;
      case "list":
        return node.ordered
          ? `<ol start="${node.start ?? 1}">${children()}</ol>`
          : `<ul>${children()}</ul>`;
      case "listItem":
        return `<li>${node.checked === null || node.checked === undefined ? "" : node.checked ? "[x] " : "[ ] "}${children()}</li>`;
      case "break":
        return "<br>";
      case "thematicBreak":
        return "<hr>";
      case "definition":
        return "";
      case "table":
        return `<div class="scroll"><table>${children()}</table></div>`;
      case "tableRow":
        return `<tr>${children()}</tr>`;
      case "tableCell":
        return `<td>${children()}</td>`;
      case "link": {
        const url = node.url ?? "";

        if (/^review-source:/i.test(url)) {
          const refs = sources.filter(
            (source) =>
              source.owner === owner && source.id === `${owner.id}:${url}`,
          );

          return refs
            .map((source) => `<a href="#${sourceId(source)}">${children()}</a>`)
            .join(" · ");
        }

        if (
          /^(?:https?:\/\/|mailto:)/i.test(url) &&
          !/[\u0000-\u0020\u007f]/.test(url)
        )
          return `<a href="${escape(url)}" rel="noreferrer noopener">${children()}</a>`;

        if (url.startsWith("#") && anchors.has(url.slice(1)))
          return `<a href="#${anchors.get(url.slice(1))}">${children()}</a>`;
        partial.add(owner);

        return `${children()} <span class="notice">[Unavailable link: ${escape(url)}]</span>`;
      }

      default:
        partial.add(owner);

        return `<span class="notice">[Unavailable Markdown ${escape(node.type)}: ${escape(node.value ?? node.alt ?? markdownText(node))}]</span>`;
    }
  };

  const render = (block: Block): string => {
    let content: string;

    switch (block.type) {
      case "markdown":
        content = markdown(trees.get(block)!, block);
        break;
      case "code":
        content = `<p>${escape(block.language)} ${escape(block.caption ?? "")}</p>${code(block.text)}`;
        break;
      case "divider":
        content = "<hr>";
        break;
      case "section":
        content = `<details${block.defaultCollapsed ? "" : " open"}><summary>${escape(block.title)}</summary>${block.children.map(render).join("")}</details>`;
        break;
      case "callout":
        content = `<aside><strong>${escape(block.tone)}: ${escape(block.title ?? "")}</strong>${block.children.map(render).join("")}</aside>`;
        break;
      case "code_peek":
        partial.add(block);
        content = `<p>${escape(block.caption ?? "Code peek")}</p>${sourceLinks(block)}<p class="notice">Cross-side alignment unavailable in M1.</p>`;
        break;
      case "trace_quote":
        partial.add(block);
        content = `<p class="notice">Unverified authored quote · trace ${escape(block.traceId)} · event ${escape(block.eventId)}</p><blockquote>${escape(block.text)}</blockquote>`;
        break;
      case "flow_diagram": {
        const ids = new Map(
          block.nodes.map((node) => [node.key, `node-${serial++}`]),
        );

        content = `<h2>${escape(block.title)}</h2><p>${escape(block.description ?? "")}</p><p>Flow diagram · ${escape(block.direction ?? "down")} · Connections are listed below; card order is not an edge.</p><div class="nodes">${block.nodes.map((node) => `<article id="${ids.get(node.key)}"><strong>${escape(node.key)}: ${escape(node.label)}</strong><p>${escape(node.kind ?? "process")} ${escape(node.description ?? "")}</p>${node.attachments.map((attachment, index) => `<p>${escape(attachment.label)}: ${attachment.sources.map((_, sourceIndex) => sourceLinks(block, `${block.id}:${node.key}:${index}:${sourceIndex}`)).join(" · ")}</p>`).join("")}</article>`).join("")}</div><h3>Connections</h3><ul>${block.edges.map((edge) => `<li><a href="#${ids.get(edge.from)}">${escape(edge.from)}</a> → <a href="#${ids.get(edge.to)}">${escape(edge.to)}</a> ${escape(edge.label ?? "")} (${escape(edge.style ?? "solid")})</li>`).join("")}</ul>`;
        break;
      }

      case "call_stack_diff":
        content = `<h2>${escape(block.title)}</h2><p>Before/after call paths; this is not a unified source diff.</p>${(["base", "head"] as const).map((side) => `<h3>${side === "base" ? "Before (base)" : "After (head)"}</h3><ol>${block[side].map((frame) => `<li><strong>${escape(frame.label ?? frame.key ?? "Frame")}</strong><p>Key: ${escape(frame.key ?? "unnamed")} · Parent: ${escape(frame.parentKey ?? "root")} ${frame.via ? `· ${escape(frame.via.kind)}: ${escape(frame.via.reason)}` : ""}</p><p>${sourceLinks(block, frame.id)}</p>${frame.callSite ? `<p>Call site: ${sourceLinks(block, `${frame.id}:call-site`)}</p>` : ""}${(frame.contextSources ?? []).map((_, index) => `<p>Context: ${sourceLinks(block, `${frame.id}:context:${index}`)}</p>`).join("")}</li>`).join("")}</ol>`).join("")}`;
        break;
      default: {
        partial.add(block);

        const resource =
          block.type === "image"
            ? `${block.assetId} · ${block.alt} · ${block.caption ?? ""}`
            : block.type === "software_map"
              ? `${block.mapVersionId} · focus ${block.focusElementId ?? "none"}`
              : block.title;

        content = `<p class="notice">Unavailable in M1: ${escape(resource)}</p>`;
      }
    }

    const identity = partial.has(block)
      ? `<p class="notice">Partial/unavailable: ${escape(block.type)} · block ${escape(block.id ?? "(unnamed)")}</p>`
      : "";

    return `<section data-block-type="${block.type}">${identity}${content}</section>`;
  };

  const body = snapshot.document.map(render).join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(snapshot.title)}</title><style>
:root{color-scheme:light dark;font:16px/1.55 var(--font-sans,system-ui),sans-serif;color:var(--foreground,CanvasText)}*{box-sizing:border-box}body{margin:0;background:transparent}main{max-width:56rem;margin:auto;padding-block:1rem;overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}section{margin-block:1rem}a{color:var(--primary,LinkText)}a:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid currentColor;outline-offset:3px}summary{cursor:pointer;padding:.5rem}article,aside,details,blockquote{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:var(--radius,.5rem);padding:.65rem;margin-block:.5rem}blockquote{margin-inline:0}.notice{font-size:.9rem}.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.5rem}pre,.scroll{max-width:100%;overflow-x:auto;white-space:pre;overscroll-behavior-x:contain}pre{padding:.75rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);font-size:.85rem}code{font-family:var(--font-mono,ui-monospace),monospace}.line{display:inline-block;min-width:100%}.number{display:inline-block;min-width:3ch;margin-right:1.5ch;opacity:.6;user-select:none}td{padding:.4rem;border:1px solid currentColor}:target{outline:2px solid currentColor;scroll-margin-block:1rem}header p{font-size:.9rem}
</style></head><body><main><header><h1>${escape(snapshot.title)}</h1><p>Saved snapshot · ${escape(snapshot.reviewId)} · version ${snapshot.version}<br>${partial.size} partial/unavailable blocks. Ask the agent for a fresh export when this review changes.</p>${snapshot.pins ? `<p>Repository ${escape(snapshot.pins.repositoryId)}<br>Base ${escape(snapshot.pins.base)}<br>Head ${escape(snapshot.pins.head)}</p>` : ""}</header>${body}<h2>Included source excerpts</h2>${sources.map((source) => `<article id="${sourceId(source)}" tabindex="-1"><h3>${escape(source.label ?? source.source.file)}</h3><p>${escape(source.source.side)}/${escape(source.source.file)}:${source.source.fromLine}–${source.source.toLine}<br>Repository ${escape(source.pins.repositoryId)} · ${escape(source.pins[source.source.side])}</p>${code(source.text, source.source.fromLine)}</article>`).join("")}<h2>Unified source patches</h2><p>Frozen file-change summary and literal patches. Interactive Diff lenses and structural navigation are unavailable.</p>${changes.length ? changes.map((file) => `<details><summary>${escape(file.path)} · ${escape(file.status)} · +${file.additions} −${file.deletions}${file.binary ? " · binary (no textual content)" : ""}</summary><p>${file.previousPath ? `Renamed from ${escape(file.previousPath)} · ` : ""}Repository ${escape(file.pins.repositoryId)}<br>${escape(file.pins.base)} → ${escape(file.pins.head)}</p>${file.patch === "" ? "<p>Empty patch text returned for this change.</p>" : code(file.patch)}</details>`).join("") : "<p>No file changes in the included comparisons.</p>"}</main></body></html>`;

  if (html.length > 480_000)
    throw new Error(
      `Portable HTML is ${html.length} characters; maximum 480000. Split the review into smaller saved reviews and export again.`,
    );

  return html;
}
