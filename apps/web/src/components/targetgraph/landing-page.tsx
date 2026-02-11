"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import { APP_QUESTION } from "@/components/targetgraph/constants";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type RunMode = "fast" | "balanced" | "deep";
type ConceptType = "disease" | "target" | "drug" | "intervention" | "pathway";

type CanonicalEntity = {
  entityType: "disease" | "target" | "drug";
  id: string;
  name: string;
  description?: string;
  score: number;
};

type ResolvedConcept = {
  mention: string;
  type: ConceptType;
  selected: CanonicalEntity | null;
  alternatives: CanonicalEntity[];
};

type SuggestEntitiesResponse = {
  concepts: ResolvedConcept[];
};

type SuggestQueryResponse = {
  suggestions: string[];
};

const modeDescription: Record<RunMode, string> = {
  fast: "Fast first-pass mechanism brief.",
  balanced: "Balanced depth for translational review.",
  deep: "Maximum depth with broader evidence context.",
};

function localAutocompleteSeed(prefix: string): string[] {
  const base = prefix.trim().replace(/\s+/g, " ");
  if (base.length < 4) return [];
  if (base.endsWith("?")) return [];

  if (/^what are the\b/i.test(base)) {
    return [
      `${base} top targets with strongest evidence?`,
      `${base} key pathway and compound anchors?`,
      `${base} main translational caveats?`,
    ];
  }

  if (/^for\b/i.test(base)) {
    return [
      `${base} what mechanism path is strongest?`,
      `${base} which target has tractable compounds?`,
      `${base} what evidence gaps block nomination?`,
    ];
  }

  return [
    `${base} strongest mechanism path?`,
    `${base} most actionable target and compound?`,
    `${base} highest-priority evidence gaps?`,
  ];
}

function conceptTone(type: ConceptType) {
  if (type === "disease") return "border-[#ffd4a7] bg-[#fff2e2] text-[#8d4f16]";
  if (type === "target") return "border-[#dfcbff] bg-[#f5efff] text-[#5d3aa3]";
  if (type === "drug") return "border-[#ffd7b0] bg-[#fff4e8] text-[#9a5a12]";
  if (type === "intervention") return "border-[#ffcba6] bg-[#fff0e0] text-[#9b4f1f]";
  return "border-[#ead8ff] bg-[#f8f1ff] text-[#6d4aa5]";
}

export function LandingPage() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RunMode>("balanced");
  const [concepts, setConcepts] = useState<ResolvedConcept[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState<number>(-1);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isAutocompleting, setIsAutocompleting] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 4 || trimmed.endsWith("?")) {
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
      return;
    }

    const seeded = localAutocompleteSeed(trimmed);
    setSuggestions(seeded);
    setActiveSuggestionIndex(seeded.length > 0 ? 0 : -1);

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsAutocompleting(true);
      try {
        const response = await fetch(
          `/api/suggestQuery?prefix=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        const payload = (await response.json()) as SuggestQueryResponse;
        const nextSuggestions = (payload.suggestions ?? [])
          .map((value) => value.trim())
          .filter((value) => value.length > trimmed.length + 2)
          .slice(0, 3);
        if (nextSuggestions.length > 0) {
          setSuggestions(nextSuggestions);
          setActiveSuggestionIndex(0);
        }
      } catch {
        // Keep seeded local suggestions when network/autocomplete fails.
      } finally {
        setIsAutocompleting(false);
      }
    }, 90);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 7) {
      setConcepts([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsSuggesting(true);
      try {
        const response = await fetch(
          `/api/suggestEntities?query=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        const payload = (await response.json()) as SuggestEntitiesResponse;
        setConcepts(payload.concepts ?? []);
      } catch {
        setConcepts([]);
      } finally {
        setIsSuggesting(false);
      }
    }, 460);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const selectedDisease = useMemo(
    () =>
      concepts.find(
        (concept) => concept.selected?.entityType === "disease" && concept.selected?.id,
      )?.selected ?? null,
    [concepts],
  );

  const hoverEntity = useMemo(() => {
    if (hoveredIndex === null) return null;
    const concept = concepts[hoveredIndex];
    if (!concept?.selected) return null;
    return {
      concept,
      entity: concept.selected,
    };
  }, [concepts, hoveredIndex]);

  const canRun = query.trim().length >= 8;

  const run = () => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 8) return;

    const params = new URLSearchParams({
      query: trimmedQuery,
      mode,
    });

    if (selectedDisease) {
      params.set("diseaseId", selectedDisease.id);
      params.set("diseaseName", selectedDisease.name);
    }

    router.push(`/brief?${params.toString()}`);
  };

  const applySuggestion = (value: string) => {
    setQuery(value);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-7 px-4 pb-14 pt-10 md:px-8 md:pt-14">
        <header className="tg-panel-rise space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-[#f0872d] px-3 py-1 text-white">TargetGraph</Badge>
            <Badge className="rounded-full border border-[#ffd2ad] bg-white/88 text-[#884f1c]">
              Target nomination brief
            </Badge>
          </div>

          <h1 className="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-[#24206d] md:text-6xl">
            Ask one disease question. Receive one ranked mechanism brief.
          </h1>

          <p className="max-w-4xl text-sm leading-7 text-[#4d3268] md:text-base">{APP_QUESTION}</p>

          <div className="inline-flex rounded-full border border-[#f2c38b] bg-[#fff6e8] px-4 py-2 text-xs font-medium text-[#9a5510]">
            Preclinical evidence synthesis only; not for clinical decision-making.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.34fr_0.86fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#f0d8c3] bg-white/94 p-5 shadow-[0_20px_80px_rgba(170,107,42,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#8b4e1a]">
              Ask question
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#b26a2b]" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveSuggestionIndex(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && suggestions.length > 0) {
                    event.preventDefault();
                    setActiveSuggestionIndex((prev) => (prev + 1) % suggestions.length);
                    return;
                  }
                  if (event.key === "ArrowUp" && suggestions.length > 0) {
                    event.preventDefault();
                    setActiveSuggestionIndex((prev) =>
                      prev <= 0 ? suggestions.length - 1 : prev - 1,
                    );
                    return;
                  }
                  if (
                    (event.key === "Enter" || event.key === "Tab") &&
                    suggestions.length > 0 &&
                    activeSuggestionIndex >= 0
                  ) {
                    event.preventDefault();
                    applySuggestion(suggestions[activeSuggestionIndex]!);
                    return;
                  }
                  if (event.key === "Enter") run();
                }}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => {
                  window.setTimeout(() => setIsInputFocused(false), 120);
                }}
                placeholder="Type a free-text biomedical question"
                className="h-12 w-full rounded-xl border border-[#ffd6b0] bg-[#fff9f2] pl-9 pr-3 text-sm text-[#4f2f59] outline-none ring-[#f0872d] placeholder:text-[#a07162] focus:ring-2"
              />

              {isInputFocused && (suggestions.length > 0 || isAutocompleting) ? (
                <div className="absolute left-0 right-0 top-[52px] z-30 rounded-xl border border-[#ffd9b7] bg-white p-2 shadow-[0_18px_40px_rgba(165,102,42,0.2)]">
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-[#9f5d26]">
                    <Sparkles className="h-3.5 w-3.5" /> Smart autocomplete
                  </div>
                  {isAutocompleting && suggestions.length === 0 ? (
                    <div className="rounded-lg px-2 py-1.5 text-xs text-[#ac7d54]">
                      Thinking...
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {suggestions.map((suggestion, index) => (
                        <button
                          key={suggestion}
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applySuggestion(suggestion);
                          }}
                          className={`block w-full rounded-lg border px-2 py-1.5 text-left text-xs ${
                            index === activeSuggestionIndex
                              ? "border-[#f7b37e] bg-[#fff0df] text-[#7c4719]"
                              : "border-[#ffe6cf] bg-white text-[#8e5b37]"
                          }`}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="space-y-2 rounded-xl border border-[#f2dfce] bg-[#fffaf3] p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8f5420]">
                  Semantic entity mapping
                </div>
                <div className="text-[11px] text-[#a37249]">
                  {isSuggesting ? "Resolving..." : `${concepts.length} concept(s)`}
                </div>
              </div>

              {concepts.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {concepts.map((concept, index) => (
                    <button
                      key={`${concept.mention}-${index}`}
                      type="button"
                      onMouseEnter={() => setHoveredIndex(index)}
                      onMouseLeave={() => setHoveredIndex(null)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] ${conceptTone(concept.type)}`}
                    >
                      {concept.mention}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[#997550]">
                  Submit anytime. Concepts resolve after typing settles (disease/target/drug/intervention).
                </div>
              )}

              {hoverEntity ? (
                <div className="rounded-lg border border-[#ffd9bb] bg-white px-2.5 py-2 text-xs text-[#6e431d]">
                  <div className="font-semibold text-[#7b4b1b]">
                    {hoverEntity.entity.name}
                  </div>
                  <div className="text-[#a0683e]">
                    {hoverEntity.entity.entityType.toUpperCase()} • {hoverEntity.entity.id}
                  </div>
                  <div className="mt-1 text-[#a0683e]">
                    {hoverEntity.entity.description ?? "Canonical entity metadata not provided."}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="text-xs text-[#a0754e]">
              Matching uses semantic extraction + ontology search. It avoids alpha/beta family swaps.
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#f0d8c3] bg-white/94 p-5 shadow-[0_20px_80px_rgba(170,107,42,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#8b4e1a]">
              Run profile
            </div>

            <div className="space-y-2">
              {(["fast", "balanced", "deep"] as RunMode[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                    mode === item
                      ? "border-[#f0872d] bg-[#fff0df] text-[#7c4719]"
                      : "border-[#f2dfce] bg-[#fff9f2] text-[#7f5634]"
                  }`}
                  onClick={() => setMode(item)}
                >
                  <div className="font-semibold capitalize">
                    {item === "fast"
                      ? "Triage"
                      : item === "balanced"
                        ? "Program review"
                        : "Due diligence"}
                  </div>
                  <div className="mt-0.5 text-xs text-[#9f724d]">{modeDescription[item]}</div>
                </button>
              ))}
            </div>

            <Button
              className="h-11 w-full bg-[#f0872d] text-white hover:bg-[#d6711d]"
              onClick={run}
              disabled={!canRun}
            >
              Generate evidence brief <ArrowRight className="ml-1 h-4 w-4" />
            </Button>

            <div className="rounded-xl border border-[#f3d1ab] bg-[#fff7ec] p-3 text-xs text-[#8a4e16]">
              Expected runtime: ~20–30s in Program Review mode.
            </div>
          </aside>
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-[#5049ad]">What happens next</div>
            <p className="text-xs leading-6 text-[#464187]">
              The run streams entity resolution, then target/pathway/drug/interaction retrieval, and returns a ranked mechanism with explicit caveats.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#f3d1ab] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-[#b36218]">Deliverable</div>
            <p className="text-xs leading-6 text-[#5c4a3a]">
              Exportable brief JSON for program review with recommendation rationale, alternatives, and evidence references.
            </p>
          </div>
        </section>

        <footer className="space-y-1 border-t border-[#ddd9ff] pt-4 text-[11px] text-[#625ea2]">
          <div>
            Open Targets GraphQL endpoint:{" "}
            <a
              className="underline underline-offset-4"
              href="https://api.platform.opentargets.org/api/v4/graphql"
              target="_blank"
              rel="noreferrer"
            >
              https://api.platform.opentargets.org/api/v4/graphql
            </a>
          </div>
          <div>
            Reactome Content Service (current supported API):{" "}
            <a
              className="underline underline-offset-4"
              href="https://reactome.org/ContentService/"
              target="_blank"
              rel="noreferrer"
            >
              https://reactome.org/ContentService/
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
