/**
 * The three fixed render sizes a UI check captures at (PRD "Defaults to ship
 * with"). Viewport dimensions are UI-check domain knowledge, so they live in the
 * domain layer (`ui-runner`) — a UICheck stores only the viewport *labels*, and
 * the worker resolves them to sizes here before driving `runUI`.
 */
import type { Viewport } from "./types.ts";

export const VIEWPORTS: Record<"mobile" | "tablet" | "desktop", Viewport> = {
  mobile: { label: "mobile", width: 375, height: 812 },
  tablet: { label: "tablet", width: 768, height: 1024 },
  desktop: { label: "desktop", width: 1440, height: 900 },
};

/**
 * Resolve stored viewport labels to full `Viewport` sizes, preserving order.
 * Throws on an unknown label — config-repo validates the stored set against the
 * same canonical labels, so an unknown one here means corrupt data.
 */
export function resolveViewports(labels: string[]): Viewport[] {
  return labels.map((label) => {
    const viewport = (VIEWPORTS as Record<string, Viewport | undefined>)[label];
    if (!viewport) {
      throw new Error(`unknown viewport label: ${label}`);
    }
    return viewport;
  });
}
