// Shared UI tokens.
//
// ROLE_COLOR is the primary indigo every portal passes to Layout as its role
// accent; the dashboards import it here instead of each redeclaring the hex.
// `density` is the compact table/list scale (px, unitless lineHeight) — defined
// ahead of use and not applied anywhere yet.

export const ROLE_COLOR = '#2441E5'

export const density = {
  rowPadY:    6,
  rowPadX:    14,
  bodySize:   13,
  headSize:   11,
  lineHeight: 1.35,
}
