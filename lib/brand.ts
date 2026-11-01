/**
 * The product's own name. One place, so a rename is one line (plus electron-builder.config.js, which
 * cannot import TypeScript). A shop's own name replaces it everywhere once the shop exists.
 *
 * NEXT_PUBLIC_PLATFORM_NAME lets a reseller run the same build under their own name.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_PLATFORM_NAME || "Tillwise";
export const APP_TAGLINE = "Point of sale for any business";
