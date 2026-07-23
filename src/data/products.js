// Single source of truth for the title-search product catalog. Used by the
// client Place-Order form (names, prices, descriptions, turnaround) AND by
// billing's invoice estimate — previously these were separate lists with
// mismatched prices (e.g. the form quoted "Full Search" at $150 while billing
// estimated $175, and form-only names like "Current Owner Search" fell through
// to a flat $125). Keeping one catalog guarantees the invoice matches the price
// the client saw when ordering.
export const PRODUCTS = [
  { name:'Current Owner Search', price:75,  tat:'8–16 hr',  desc:'Current owner rundown forward from and including the current vesting document with all supporting documentation. Includes chain of title, legal description, requirements, and exceptions.' },
  { name:'Two Owner Search',     price:100, tat:'16–24 hr', desc:'Current vesting deed and all deeds back to the deed prior to the out-of-family deed. Includes copies of open mortgages and assignments, any judgments and liens against those owners, and tax assessment and current tax info including delinquencies.' },
  { name:'Full Search',          price:150, tat:'24–48 hr', desc:'Current vesting deed and all deeds back to state statute or a developer. Includes open mortgages and assignments, judgments and liens, and tax assessment and current tax information including delinquencies.' },
  { name:'Update / Bringdown',   price:45,  tat:'8–16 hr',  desc:'An extension of a title search to verify no liens have been filed between the original search and the recording of the deed or mortgage. Update on tax info from last effective date; any newly recorded instruments.' },
  { name:'Commercial Search',    price:250, desc:'Commitment-ready report for commercial properties.' },
  { name:'Energy / Infrastructure', price:350, desc:'Solar, wind, pipelines, cell towers, EV infrastructure.' },
  { name:'Tax Search',           desc:'Property tax assessment, current tax status, and delinquency information.' },
  { name:'Patriot Name Search',  desc:'OFAC / Patriot Act compliance name search against government watch lists.' },
  { name:'Bankruptcy Name Search', desc:'Federal bankruptcy court name search for all parties in the transaction.' },
  { name:'Document Retrieval',   desc:'Retrieval of specific recorded documents from county and municipal records.' },
]

// Legacy / internal short type names carried by mock + seed data and set from
// the admin edit modal. Aligned to their catalog equivalents so their invoices
// stay consistent with the same product ordered through the form.
const LEGACY_TYPE_PRICE = {
  'Two-Owner': 100, 'Current Owner': 75, 'Lien Search': 110,
  'Tax Certificate': 95, 'HOA Estoppel': 120,
}

// type/name → fixed price (undefined for quote-only products, e.g. Tax Search).
export const PRODUCT_PRICE = {
  ...Object.fromEntries(PRODUCTS.filter(p => p.price != null).map(p => [p.name, p.price])),
  ...LEGACY_TYPE_PRICE,
}
