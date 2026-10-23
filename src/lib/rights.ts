/**
 * Sync licensing model.
 *
 * This is what turns a ranked list into a transaction. A cue is only buyable if
 * you can name the rights, the fee and the path to a signature, so this module
 * derives all three from the same Qloo signals that produced the ranking.
 *
 * Everything here is an ESTIMATE from a transparent model, not a quote. Cue has
 * no access to actual publishing splits, label deal terms or MFN clauses, and
 * presenting invented numbers as fact would be the same failure mode as
 * inventing a track title. The model is exposed in the UI so a supervisor can
 * see exactly which inputs moved the number.
 */

import type { Cue } from "./types";

export type Placement = Cue["placement"];

/** How the cue is used. Drives fee far more than the artist's fame does. */
export interface LicenseTerms {
  termYears: 1 | 3 | 10;
  territory: "worldwide" | "north_america" | "europe" | "single_market";
  media: "festival" | "streaming" | "broadcast" | "social" | "all_media";
  exclusive: boolean;
}

export const DEFAULT_TERMS: LicenseTerms = {
  termYears: 1,
  territory: "worldwide",
  media: "all_media",
  exclusive: false,
};

export interface FeeBand {
  low: number;
  high: number;
  /** The single number a buyer should budget against. */
  recommended: number;
  currency: "USD";
}

export interface RightsHolder {
  role: "master" | "publishing" | "artist";
  party: string;
  share: number;
  note: string;
}

export interface ClearanceStep {
  step: string;
  party: string;
  days: number;
}

export interface ClearancePath {
  /** One-stop means a single negotiation clears both sides. */
  oneStop: boolean;
  difficulty: "light" | "moderate" | "heavy";
  totalDays: number;
  steps: ClearanceStep[];
}

export interface LicenseQuote {
  cueId: string;
  artist: string;
  track: string;
  terms: LicenseTerms;
  placement: Placement;
  fee: FeeBand;
  clearance: ClearancePath;
  holders: RightsHolder[];
  /** Every input that moved the price, with its multiplier, for the receipts. */
  drivers: Array<{ label: string; multiplier: number; note: string }>;
  /** Cue's marketplace commission on the recommended fee. */
  takeRate: number;
  takeAmount: number;
  disclaimer: string;
}

/**
 * Placement prominence. A needle drop over picture is the most valuable use of
 * a track; a transition bed is the least. These multipliers follow the shape of
 * real sync quotes, where the same song can differ by an order of magnitude
 * between a title card and a feature needle drop.
 */
const PLACEMENT_WEIGHT: Record<Placement, number> = {
  needle_drop: 1.6,
  title_card: 1.15,
  score_bed: 0.85,
  transition: 0.6,
};

const PLACEMENT_LABEL: Record<Placement, string> = {
  needle_drop: "Needle drop over picture",
  title_card: "Title card",
  score_bed: "Score bed under dialogue",
  transition: "Transition bed",
};

const MEDIA_WEIGHT: Record<LicenseTerms["media"], number> = {
  festival: 0.35,
  social: 0.5,
  streaming: 0.9,
  broadcast: 1.0,
  all_media: 1.5,
};

const TERRITORY_WEIGHT: Record<LicenseTerms["territory"], number> = {
  single_market: 0.55,
  europe: 0.8,
  north_america: 0.85,
  worldwide: 1.25,
};

const TERM_WEIGHT: Record<LicenseTerms["termYears"], number> = {
  1: 0.75,
  3: 1.0,
  10: 1.45,
};

/** Base fee before any weighting, for a minimal independent sync use. */
const BASE_FEE = 200;

/**
 * No clearance is free. Even an unknown artist in one market at a festival still
 * carries paperwork, an invoice and Cue's handling, so the model floors there.
 */
const MINIMUM_FEE = 250;

/**
 * Popularity is the only label-leverage proxy Qloo exposes, so it drives the
 * baseline. The curve is deliberately convex: leverage is not linear in fame,
 * and a 0.99-popularity major costs far more than twice a 0.5.
 */
function popularityMultiplier(popularity: number): number {
  const clamped = Math.min(1, Math.max(0, popularity));
  return 0.6 + Math.pow(clamped, 2.2) * 14;
}

/**
 * Momentum prices in cultural currency. An artist climbing Qloo's population
 * rank is worth more at signature than one cooling, because the cue will still
 * be culturally current when the campaign breaks.
 */
function momentumMultiplier(momentum: number): number {
  if (momentum > 0) return 1.2;
  if (momentum < 0) return 0.9;
  return 1.0;
}

/** Round to a plausible negotiating number rather than a spurious precise one. */
function roundFee(value: number): number {
  if (value < 1500) return Math.round(value / 50) * 50;
  if (value < 10000) return Math.round(value / 250) * 250;
  if (value < 100000) return Math.round(value / 1000) * 1000;
  return Math.round(value / 5000) * 5000;
}

/**
 * Keep the band strictly ordered around the recommendation. Rounding can
 * collapse a small band onto the recommended value, and a quote whose low equals
 * its high reads as a fixed price, which this model never is.
 */
function feeBand(recommended: number): FeeBand {
  const step = recommended < 1500 ? 50 : recommended < 10000 ? 250 : 1000;
  const low = Math.min(roundFee(recommended * 0.7), recommended - step);
  const high = Math.max(roundFee(recommended * 1.45), recommended + step);
  return { low: Math.max(step, low), high, recommended, currency: "USD" };
}

export function quoteLicense(cue: Cue, terms: LicenseTerms): LicenseQuote {
  const popularity = cue.popularity || 0;
  // Cues arrive from the client at /api/quote, so a malformed one must not be
  // able to produce a NaN price. An unknown placement falls back to the most
  // common sync use rather than poisoning every fee with NaN.
  const placement: Placement = PLACEMENT_WEIGHT[cue.placement] ? cue.placement : "score_bed";

  const drivers: LicenseQuote["drivers"] = [
    {
      label: PLACEMENT_LABEL[placement],
      multiplier: PLACEMENT_WEIGHT[placement],
      note: "Prominence of the use over picture.",
    },
    {
      label: `Media: ${terms.media.replace(/_/g, " ")}`,
      multiplier: MEDIA_WEIGHT[terms.media],
      note: "Which channels the licence covers.",
    },
    {
      label: `Territory: ${terms.territory.replace(/_/g, " ")}`,
      multiplier: TERRITORY_WEIGHT[terms.territory],
      note: "Geographic reach of the grant.",
    },
    {
      label: `Term: ${terms.termYears} ${terms.termYears === 1 ? "year" : "years"}`,
      multiplier: TERM_WEIGHT[terms.termYears],
      note: "How long the licence runs.",
    },
    {
      label: `Catalogue leverage (popularity ${popularity.toFixed(2)})`,
      multiplier: popularityMultiplier(popularity),
      note: "Qloo popularity as a proxy for label and publisher leverage.",
    },
    {
      label: "Momentum",
      multiplier: momentumMultiplier(cue.momentum),
      note:
        cue.momentum > 0
          ? "Climbing Qloo population rank, so the track is worth more now than last year."
          : cue.momentum < 0
            ? "Cooling in Qloo's population rank, which is negotiating room."
            : "Flat trend, priced neutrally.",
    },
  ];

  if (terms.exclusive) {
    drivers.push({
      label: "Exclusivity",
      multiplier: 2.1,
      note: "Category exclusivity blocks competing placements for the term.",
    });
  }

  // Discovery picks carry a discount: the artist is adjacent rather than
  // obvious, so the catalogue is typically less contested and cheaper to clear.
  if (cue.discovery) {
    drivers.push({
      label: "Discovery pick",
      multiplier: 0.8,
      note: "Cross-domain adjacent artist, typically a less contested catalogue.",
    });
  }

  // The drivers compound. A grant covering all media worldwide for ten years is
  // not "all media plus worldwide plus ten years" — each lever multiplies the
  // exposure, so summing them would let one large driver (popularity) swamp the
  // rest and make four of the five media options round to the same price.
  const product = drivers.reduce((total, driver) => total * driver.multiplier, 1);
  const recommended = Math.max(MINIMUM_FEE, roundFee(BASE_FEE * product));

  return {
    cueId: cue.id,
    artist: cue.artist,
    track: cue.track,
    terms,
    placement,
    fee: feeBand(recommended),
    clearance: clearancePath(cue),
    holders: rightsHolders(cue),
    drivers,
    takeRate: TAKE_RATE,
    takeAmount: Math.round(recommended * TAKE_RATE),
    disclaimer:
      "Estimated from Cue's model using Qloo popularity, momentum and the selected terms. Not a quote. Confirm splits, MFN and re-use terms with the rights holders.",
  };
}

/** Cue's marketplace commission on a cleared placement. */
export const TAKE_RATE = 0.12;

/**
 * Who has to sign. The split between master and publishing is a standard
 * template, NOT actual ownership data — Cue cannot see real deal terms, and the
 * UI states that plainly.
 */
function rightsHolders(cue: Cue): RightsHolder[] {
  const major = cue.popularity > 0.8;
  const indie = cue.popularity < 0.5;

  const label = major
    ? `${cue.artist}'s label (major)`
    : indie
      ? `${cue.artist}'s label (independent)`
      : `${cue.artist}'s label`;

  return [
    {
      role: "master",
      party: label,
      share: 0.5,
      note: "Controls the recording. Signs the master use licence.",
    },
    {
      role: "publishing",
      party: `${cue.artist}'s publisher`,
      share: 0.5,
      note: "Controls the composition. Signs the synchronisation licence.",
    },
    {
      role: "artist",
      party: cue.artist,
      share: 0,
      note: "Consent is usually required for advertising use regardless of the split.",
    },
  ];
}

/**
 * How long and how painful the clearance is. Independent catalogues can often
 * clear both sides in one conversation; major catalogue requires two
 * negotiations that have to move in parallel.
 */
function clearancePath(cue: Cue): ClearancePath {
  const popularity = cue.popularity || 0;

  if (popularity < 0.5) {
    return {
      oneStop: true,
      difficulty: "light",
      totalDays: 7,
      steps: [
        { step: "Request master + sync together", party: "Independent label", days: 3 },
        { step: "Confirm artist consent", party: "Artist / management", days: 2 },
        { step: "Issue licence and invoice", party: "Cue", days: 2 },
      ],
    };
  }

  if (popularity <= 0.8) {
    return {
      oneStop: false,
      difficulty: "moderate",
      totalDays: 21,
      steps: [
        { step: "Master use request", party: "Label sync department", days: 10 },
        { step: "Synchronisation request", party: "Publisher", days: 10 },
        { step: "Artist consent", party: "Artist / management", days: 5 },
        { step: "Issue licence and invoice", party: "Cue", days: 2 },
      ],
    };
  }

  return {
    oneStop: false,
    difficulty: "heavy",
    totalDays: 45,
    steps: [
      { step: "Master use request", party: "Major label sync department", days: 20 },
      { step: "Synchronisation request", party: "Major publisher", days: 20 },
      { step: "Artist consent and approval of cut", party: "Artist / management", days: 15 },
      { step: "Most-favoured-nation review", party: "Label legal", days: 10 },
      { step: "Issue licence and invoice", party: "Cue", days: 2 },
    ],
  };
}

export interface QuoteSummary {
  quotes: LicenseQuote[];
  totalRecommended: number;
  totalTake: number;
  /** The single longest clearance path gates the whole campaign. */
  gatingDays: number;
  currency: "USD";
}

export function summariseQuotes(quotes: LicenseQuote[]): QuoteSummary {
  return {
    quotes,
    totalRecommended: quotes.reduce((total, quote) => total + quote.fee.recommended, 0),
    totalTake: quotes.reduce((total, quote) => total + quote.takeAmount, 0),
    gatingDays: quotes.reduce((max, quote) => Math.max(max, quote.clearance.totalDays), 0),
    currency: "USD",
  };
}

/**
 * The most a catalogue can be worth and still fit a budget.
 *
 * `quoteLicense` is non-decreasing in popularity — a more famous catalogue never
 * costs less — which makes it invertible. That inversion is the whole point of
 * substitution: it lets a supervisor start from the number they have rather than
 * the artist they want, and ask Qloo for what else serves the scene inside it.
 *
 * Everything except popularity is held at the cue's own values, so the ceiling
 * describes this placement under these terms rather than a generic one. The
 * result is a search hint, not a guarantee: the caller must still price each
 * candidate it gets back, because the model quantises fees and a candidate's own
 * momentum and discovery discount move its price off the curve.
 *
 * Returns 0 when even the cheapest catalogue at these terms exceeds the budget,
 * which the caller should surface as "no substitute exists at this budget"
 * rather than silently returning nothing.
 */
export function popularityCeilingForBudget(
  cue: Cue,
  terms: LicenseTerms,
  budget: number,
): number {
  const feeAt = (popularity: number) =>
    quoteLicense({ ...cue, popularity }, terms).fee.recommended;

  if (budget <= 0) return 0;
  if (feeAt(0) > budget) return 0;
  if (feeAt(1) <= budget) return 1;

  let low = 0;
  let high = 1;
  // 30 halvings is far past float resolution on 0..1, so this converges.
  for (let step = 0; step < 30; step += 1) {
    const mid = (low + high) / 2;
    if (feeAt(mid) <= budget) low = mid;
    else high = mid;
  }
  return low;
}
