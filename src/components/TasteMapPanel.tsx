import type { CueSheet } from "@/lib/types";
import type { CrossDomainItem } from "@/lib/crossdomain";

/**
 * The Cross-Domain Taste Map.
 *
 * The cue sheet answers "what should play". This panel answers the question one
 * step out: what else belongs to the cultural world of this scene — which brands,
 * which destinations, which podcasts, which rooms.
 *
 * Every row is a Qloo entity with a measured affinity for the brief's own anchors.
 * Nothing here is generated prose, and nothing here is a percentage: an affinity
 * score is a position within one query, not a share of an audience. The copy says
 * so, because a reader who assumes "0.95 = 95% of fans" has been misled even
 * though every number on screen is real.
 *
 * Anchor provenance is per result where Qloo supplies it. When the response
 * carries no attribution block the row says it is related through the anchors
 * collectively — which is what the request establishes — rather than asserting
 * that each anchor independently supports it.
 */
export function TasteMapPanel({ sheet }: { sheet: CueSheet }) {
  const map = sheet.tasteMap;

  // No anchors means the map was never measured. Render nothing rather than an
  // empty frame: there is no discovery to report and no failure to explain.
  if (!map || map.anchors.length === 0) return null;

  const anchorNames = map.anchors.map((anchor) => anchor.name);
  const hasAny = map.groups.length > 0;

  return (
    <section
      id="taste-map"
      className="panel grain relative scroll-mt-20 overflow-hidden p-5"
      aria-label="Cross-domain taste map"
    >
      <div className="relative z-10">
        <header>
          <h2 className="font-display text-xl text-haze-100">
            Explore the cultural world around your scene
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
            Qloo-derived affinity for the selected cultural anchors. Same measurement as the cue
            sheet, pointed at what else this audience connects to.
          </p>
        </header>

        {/* The anchors the whole map was measured against, stated once rather than
            repeated on every row. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-haze-500">
            Measured on
          </span>
          {anchorNames.map((name) => (
            <span
              key={name}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-haze-300"
            >
              {name}
            </span>
          ))}
        </div>

        {hasAny ? (
          <div className="mt-5 space-y-5">
            {map.groups.map((group) => (
              <div key={group.domain}>
                <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
                  {group.label}
                </h3>
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((item) => (
                    <TasteMapItem key={item.entityId} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-5 rounded-lg border border-white/5 bg-black/20 p-3 text-xs leading-relaxed text-haze-500">
            {map.failedDomains.length > 0
              ? "Qloo did not answer in time for these domains, so no discoveries are shown. The cue sheet above is unaffected."
              : "Qloo returned no cross-domain discoveries for these anchors. Naming a film, show or artist as a reference usually gives the taste graph more to work from."}
          </p>
        )}

        {/* Domains that answered with nothing, and domains that failed. Reported
            separately because "no matches" and "the call failed" are different
            facts and only one of them is about this scene. */}
        {hasAny && map.emptyDomains.length > 0 ? (
          <p className="mt-3 text-[11px] text-haze-500">
            No matches in {formatList(map.emptyDomains.map(domainLabel))} for these anchors.
          </p>
        ) : null}

        {hasAny && map.failedDomains.length > 0 ? (
          <p className="mt-3 text-[11px] text-haze-500">
            The {formatList(map.failedDomains.map(domainLabel))}{" "}
            {map.failedDomains.length === 1 ? "query" : "queries"} did not complete, so no
            discoveries are shown for {map.failedDomains.length === 1 ? "it" : "them"}.
          </p>
        ) : null}

        <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-haze-500">
          Scores are Qloo affinity for these anchors — a measured position, not a share of an
          audience and not a probability. Each result is related through the anchors above.
        </p>
      </div>
    </section>
  );
}

function TasteMapItem({ item }: { item: CrossDomainItem }) {
  const attributed = item.attributedAnchors;
  // Distinguish a measured affinity from a popularity figure the client substituted
  // when Qloo returned no affinity. Showing the two identically would present a
  // global percentile as a measured audience score.
  const measured = item.affinitySource !== "popularity";

  return (
    <li className="flex flex-col rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-haze-100" title={item.name}>
          {item.name}
        </p>
        {typeof item.affinity === "number" ? (
          <span
            className="shrink-0 font-mono text-xs text-signal-400"
            title={measured ? "Qloo affinity for these anchors" : "Qloo popularity — no affinity returned"}
          >
            {item.affinity.toFixed(3)}
            {!measured ? <span className="ml-1 text-[10px] text-haze-500">pop</span> : null}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-haze-500">
        {attributed.length > 0
          ? `Related through ${formatList(attributed)}`
          : "Related through the anchors above"}
      </p>
    </li>
  );
}

function domainLabel(domain: string): string {
  if (domain === "brand") return "brands";
  if (domain === "destination") return "destinations";
  if (domain === "podcast") return "podcasts";
  if (domain === "place") return "places";
  return domain;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
