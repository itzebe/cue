import type { CueSheet } from "@/lib/types";

/**
 * Comparables: the films, shows and books that share the brief's audience.
 *
 * This is the panel a director or writer reaches for first, and it is the one an
 * LLM answers worst. Ask a model "what's this like?" and it returns films that
 * share a genre. Qloo returns the ones whose measured audience overlaps — which
 * is why an anchor of Drive surfaces The Town and The Place Beyond the Pines,
 * heist films with that audience, rather than any of the many other thrillers.
 *
 * Each domain is labelled and its own list, because "books" answering the same
 * brief as "films" is the cross-domain claim made visible.
 */
export function ComparablesPanel({ sheet }: { sheet: CueSheet }) {
  const comparables = sheet.comparables;
  if (!comparables || comparables.groups.length === 0) return null;

  const domains = comparables.groups.map((group) => group.label.toLowerCase());

  return (
    <section id="comparables" className="panel grain relative scroll-mt-20 overflow-hidden p-5" aria-label="Comparables">
      <header>
        <h2 className="font-display text-xl text-haze-100">What this is like</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-haze-500">
          {domains.length > 1
            ? `Films, shows and books ranked on the same audience as the cues — ${formatList(domains)}, one audience measurement each.`
            : "Ranked on the same audience as the cues, not on shared genre labels."}
        </p>
      </header>

      <div className="mt-4 space-y-5">
        {comparables.groups.map((group) => (
          <div key={group.domain}>
            <h3 className="text-[10px] uppercase tracking-wider text-haze-500">
              {group.label}
            </h3>
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => (
                <li
                  key={item.entityId}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-haze-100">{item.name}</p>
                    {item.releaseYear ? (
                      <p className="text-[10px] text-haze-500">{item.releaseYear}</p>
                    ) : null}
                  </div>
                  {/* Popularity, not affinity: Qloo does not return an affinity
                      score for these rows, and showing a 0.00 would read as a
                      measured disagreement rather than an absent measurement. */}
                  {item.popularity > 0 ? (
                    <span
                      className="shrink-0 font-mono text-xs text-signal-400"
                      title="Qloo popularity, not affinity"
                    >
                      {item.popularity.toFixed(2)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {comparables.emptyDomains.length > 0 ? (
        <p className="mt-3 text-[11px] text-haze-500">
          No matches in {formatList(comparables.emptyDomains.map(domainLabel))} for this brief.
        </p>
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-haze-500">
        The brief&rsquo;s own anchors are excluded, so a film named as the reference is not returned
        as its own comparable. Scores are Qloo popularity, not affinity.
      </p>
    </section>
  );
}

function domainLabel(domain: string): string {
  if (domain === "movie") return "film";
  if (domain === "tv_show") return "television";
  if (domain === "book") return "books";
  return domain;
}

function formatList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
