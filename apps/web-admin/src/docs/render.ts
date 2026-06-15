import { marked } from "marked";

// Render trusted, in-repo markdown to HTML. Content is PR-reviewed and version
// controlled (never user input), so the output is safe to drop into the DOM via
// `{@html}` inside a `.prose` container. Synchronous: we use no async extensions.
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false, gfm: true }) as string;
}
