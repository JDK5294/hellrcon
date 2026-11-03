/**
 * The product's display name — the ONLY place it is written in the panel. Mirrors APP_NAME in
 * @app/shared (the panel doesn't depend on workspace packages, so the constant is duplicated
 * here); to rename the product, change both spots and every brand display, the page title, and
 * the mark letter follow. The app icons
 * are pictures of the mark (scripts/make-icons.mjs).
 */
export const APP_NAME = "hellrcon";

/** Single-letter logo mark shown next to the name. */
export const BRAND_MARK = APP_NAME.charAt(0).toUpperCase();
