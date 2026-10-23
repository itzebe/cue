"use client";

import { useEffect, useState } from "react";

/**
 * Jump links for the results column.
 *
 * A full run produces twelve panels and a very long page, so the parts of the
 * demonstration a reader is most likely to want — the comparison and the cue sheet —
 * are easy to lose below the fold. These are ordinary in-page anchors: they work
 * without JavaScript, they are reachable by keyboard, and they need no scroll
 * listener to stay honest.
 *
 * The active item is tracked with an IntersectionObserver so the list reflects
 * where the reader actually is, rather than where they were last sent.
 */
const SECTIONS = [
  { id: "audience", label: "Audience" },
  { id: "comparison", label: "Comparison" },
  { id: "cue-sheet", label: "Cue sheet" },
  { id: "budget", label: "Budget" },
  { id: "marketplace", label: "Marketplace" },
  { id: "comparables", label: "Comparables" },
  { id: "cross-domain", label: "Cross-domain" },
  { id: "market-check", label: "Market check" },
  { id: "receipts", label: "Receipts" },
];

export function SectionNav() {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const targets = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting panel wins, which keeps the highlight stable
        // when two panels are on screen at once.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      aria-label="Cue sheet sections"
      className="panel sticky top-4 z-20 overflow-x-auto p-1.5"
    >
      <ul className="flex items-center gap-1">
        {SECTIONS.map((section) => {
          const isActive = active === section.id;
          return (
            <li key={section.id} className="shrink-0">
              <a
                href={`#${section.id}`}
                aria-current={isActive ? "true" : undefined}
                className={`block whitespace-nowrap rounded-md px-3 py-2 text-xs transition ${
                  isActive
                    ? "bg-ember-500/10 text-ember-400"
                    : "text-haze-500 hover:bg-white/5 hover:text-haze-100"
                }`}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
