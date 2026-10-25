/**
 * The cultural vocabulary for venue localisation.
 *
 * The coverage engine measures how much of a pool's measurable space a selection
 * reaches. For music the measurable space is a set of taste tags. For places the
 * tags are richer but *mixed*: a Qloo place carries both what it is like
 * (`ambience:cinematic`, `decor:upscale`, `cuisine:italian`) and how it operates
 * (`credit_card:visa`, `parking:paid_street_parking`,
 * `accessibility:wheelchair_accessible_restroom`).
 *
 * Both are real Qloo data. Only the first kind is cultural. Measured across five
 * markets (Los Angeles, Tokyo, London, Seoul, Sao Paulo; 40 places), roughly 59%
 * of a place's measurable tag vocabulary sits in operational namespaces. Feeding
 * the raw pool to the coverage engine would therefore report "cultural coverage"
 * while actually scoring whether a venue takes Amex and has a restroom — the
 * exact mislabelling this product exists to catch.
 *
 * So the cultural space is defined by an explicit allowlist of namespaces, and
 * the filter fails closed: a namespace that is not on the list is excluded, so a
 * new Qloo namespace can never silently enter the calculation as cultural.
 *
 * Every namespace below was read from live responses, not assumed. The values
 * that decided each borderline case are quoted in the rationale.
 */

import type { QlooEntity } from "./types";

/**
 * Namespaces whose values describe the cultural texture of a place — what it is
 * like to be there, and who it draws — rather than how it operates.
 *
 * - `ambience` (97 live values: cinematic, classic, nostalgic, elegant, grand,
 *   casual, lively) — the mood of the room, the single most direct analogue of a
 *   music taste tag.
 * - `decor` (83: old_hollywood, industrial_chic, minimalist, european_inspired)
 *   — visual style, what a shoot would actually capture.
 * - `setting` (85: urban, historic, metropolitan, nature, cultural_district,
 *   concert_venue) — the kind of place it is in cultural terms.
 * - `neighborhood_characteristic` (73: walkable, touristic, historic, bustling,
 *   scenic, cultural_hub) — the character of the surrounding area.
 * - `interests` (167: film_industry, cinema_history, live_music, architecture,
 *   urban_exploration) — cultural affiliations the place is associated with.
 * - `activity_type` (96: dining_drinking, culture_arts, sightseeing, concerts,
 *   nature_outdoors) — what one does there culturally.
 * - `view` (63: panoramic_view, sunset_view, ocean_view,
 *   cinematic_themed_architecture) — a cultural/aesthetic draw.
 * - `time_of_day_fit` (7: afternoon, evening, late_night) — when it belongs.
 * - `cuisine` (14: italian, thai, scandinavian) — a taste dimension, not a
 *   service option.
 * - `culinary_style` (8: casual, artisanal, refined, fine_dining) — how it eats.
 * - `visit_intent` (6: destination, special_occasion, day_trip) — the role it
 *   plays in someone's cultural life.
 * - `customer_identity` (18: foodies, couples, tourists, locals, wine_enthusiasts,
 *   affluent_diners) — who the place draws. This is the audience dimension, and
 *   audience is what Cue measures everywhere else.
 *
 * Deliberately excluded, with the values that decided it:
 * - `amenity` / `amenities` (restrooms, wi_fi, lockers_available) — facilities.
 * - `accessibility` (wheelchair_accessible_restroom) — compliance, not taste.
 * - `parking`, `payments`, `credit_card` — logistics.
 * - `service_options`, `service_type`, `offerings`, `dining_option(s)`,
 *   `beverage_offering` — transactional capability.
 * - `children` (good_for_kids_birthday), `age_range` (25_29) — demographic
 *   constraints, not preferences.
 * - `dietary_option` (vegan) — a health constraint.
 * - `planning` (reservations_required) — logistics.
 * - `cost_description` (moderately_expensive) — price.
 * - `menu_highlight` (avocado_toast), `specialty_dish` (iced_latte) — menu items.
 * - `category` / `genre` (lodging, restaurant, museum) — the entity *type*.
 *   Type is not taste: every restaurant shares `genre:place:restaurant`, so
 *   including it would inflate coverage with a dimension that carries no
 *   preference.
 * - `nearby_attraction` (el_capitan_theatre) — a named neighbour, unbounded and
 *   specific rather than a dimension.
 * - Everything else unlisted (`noise_level`, `inclusivity`, `room_type`,
 *   `hotel_rating`, `event`, `collection`, `resy`, `recycling`, `pets`,
 *   `sustainability_initiative`, `activities`, `place_page_attributes`,
 *   `not_for_display`) — excluded by the fail-closed rule.
 */
export const CULTURAL_NAMESPACES = [
  "ambience",
  "decor",
  "setting",
  "neighborhood_characteristic",
  "interests",
  "activity_type",
  "view",
  "time_of_day_fit",
  "cuisine",
  "culinary_style",
  "visit_intent",
  "customer_identity",
] as const;

export type CulturalNamespace = (typeof CULTURAL_NAMESPACES)[number];

const CULTURAL_SET: ReadonlySet<string> = new Set(CULTURAL_NAMESPACES);

/** The Qloo tag-id prefix every tag carries. */
const TAG_PREFIX = "urn:tag:";

/**
 * The namespace segment of a Qloo tag id, or `null` when there is not one.
 *
 * Tag ids are `urn:tag:<namespace>:<rest>`. Examples that matter here:
 *   `urn:tag:ambience:qloo:cinematic`                  -> `ambience`
 *   `urn:tag:nearby_attraction:qloo:el_capitan_theatre` -> `nearby_attraction`
 *   `urn:tag:qloo:<something>` (artist tags)            -> `qloo`
 *
 * Artist tags have no meaningful namespace — the segment is the literal `qloo` —
 * so this returns `qloo`, which is not on the allowlist. The filter therefore
 * drops every artist tag rather than pretending a music tag is a venue
 * dimension. `cultural.ts` is only ever applied to place pools; this is the
 * property that makes misapplying it fail closed instead of corrupting the music
 * Taste Gap.
 *
 * A malformed id (null, a number, an empty string, no second segment) returns
 * `null` and is treated as non-cultural.
 */
export function namespaceOf(tagId: unknown): string | null {
  if (typeof tagId !== "string" || !tagId.startsWith(TAG_PREFIX)) return null;
  const rest = tagId.slice(TAG_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return rest.slice(0, separator);
}

/** True only for a well-formed tag id whose namespace is on the allowlist. */
export function isCulturalTag(tagId: unknown): boolean {
  const namespace = namespaceOf(tagId);
  return namespace !== null && CULTURAL_SET.has(namespace);
}

/**
 * A copy of the pool carrying only its cultural tags.
 *
 * Returns new entity objects rather than mutating: the caller keeps the original,
 * unfiltered pool for the venue list, the touchpoints and any other use. A null
 * or malformed entry is passed through with no tags rather than throwing, because
 * the pool comes off the wire and one bad row must not take the measurement down.
 */
export function filterCulturalEntities(entities: QlooEntity[] | undefined): QlooEntity[] {
  if (!Array.isArray(entities)) return [];
  return entities.map((entity) => {
    if (!entity || typeof entity !== "object") return entity;
    const tags = Array.isArray(entity.tags) ? entity.tags : [];
    return { ...entity, tags: tags.filter((tag) => isCulturalTag(tag?.tag_id)) };
  });
}

/**
 * A sentence the UI shows wherever the cultural coverage appears, so the
 * boundary of the measurement travels with the number rather than living only in
 * the markup.
 */
export const CULTURAL_VOCABULARY_NOTE =
  "Cultural coverage counts only cultural dimensions — ambience, style, setting, interests and who a place draws. Operational tags such as parking, payment and accessibility are excluded, because scoring those as cultural reach would misreport what the number means.";
