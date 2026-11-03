/**
 * The categorical series palette, addressed by the fixed slot order the dataviz skill validated
 * (slots 1..7, hue order never cycled). Components read the CSS custom properties so light/dark each
 * use their own validated steps; this helper just hands out the `var(--series-N)` reference for a
 * given index and wraps at 7 into slot 7 ("Other") rather than inventing an 8th hue.
 */
export const SERIES_COUNT = 7;

/**
 * The residual series — an "Other"/leftovers bucket — drawn in neutral ink rather than a hue.
 *
 * It is not a category competing for identity, so giving it a colour spends a palette slot on the
 * one series nobody is trying to pick out, and leaves a real category sharing a hue. Neutral also
 * separates from all seven hues by chroma alone, which no colour vision can confuse.
 */
export const RESIDUAL_INDEX = -1;

/** CSS colour reference for categorical slot `i` (0-based). Negative = the neutral residual
 *  series; anything past slot 7 folds into slot 7. */
export function seriesVar(i: number): string {
  if (i < 0) return "var(--muted)";
  return `var(--series-${Math.min(i, SERIES_COUNT - 1) + 1})`;
}
