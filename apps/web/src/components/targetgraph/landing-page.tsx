"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
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

const modeDescription: Record<RunMode, string> = {
  fast: "Fast first-pass mechanism brief.",
  balanced: "Balanced depth for translational review.",
  deep: "Maximum depth with broader evidence context.",
};

function conceptTone(type: ConceptType) {
  if (type === "disease") return "border-[#b7dcff] bg-[#eaf5ff] text-[#155a97]";
  if (type === "target") return "border-[#c9bbff] bg-[#f1ecff] text-[#4a3da1]";
  if (type === "drug") return "border-[#ffd7b0] bg-[#fff4e8] text-[#9a5a12]";
  if (type === "intervention") return "border-[#cfd9ff] bg-[#eef2ff] text-[#304f9a]";
  return "border-[#d7d2ff] bg-[#f7f5ff] text-[#5b56a1]";
}

export function LandingPage() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RunMode>("balanced");
  const [concepts, setConcepts] = useState<ResolvedConcept[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
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
    }, 120);

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

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-7 px-4 pb-14 pt-10 md:px-8 md:pt-14">
        <header className="tg-panel-rise space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-[#5b57e6] px-3 py-1 text-white">TargetGraph</Badge>
            <Badge className="rounded-full border border-[#c6c3ff] bg-white/88 text-[#332c89]">
              Target nomination brief
            </Badge>
          </div>

          <h1 className="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-[#24206d] md:text-6xl">
            Ask one disease question. Receive one ranked mechanism brief.
          </h1>

          <p className="max-w-4xl text-sm leading-7 text-[#2f2b74] md:text-base">{APP_QUESTION}</p>

          <div className="inline-flex rounded-full border border-[#f2c38b] bg-[#fff6e8] px-4 py-2 text-xs font-medium text-[#9a5510]">
            Preclinical evidence synthesis only; not for clinical decision-making.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.34fr_0.86fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/94 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Ask question
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6a66b4]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") run();
                }}
                placeholder="Type a free-text biomedical question"
                className="h-12 w-full rounded-xl border border-[#c5c7fc] bg-[#f7f7ff] pl-9 pr-3 text-sm text-[#221f62] outline-none ring-[#5b57e6] placeholder:text-[#6e6aa9] focus:ring-2"
              />
            </div>

            <div className="space-y-2 rounded-xl border border-[#ddd9ff] bg-[#f8f8ff] p-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5f59a1]">
                  Semantic entity mapping
                </div>
                <div className="text-[11px] text-[#6d68ac]">
                  {isSuggesting ? "Updating..." : `${concepts.length} concept(s)`}
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
                <div className="text-xs text-[#726eaf]">
                  Write a disease question. Concepts are mapped live (disease/target/drug/intervention).
                </div>
              )}

              {hoverEntity ? (
                <div className="rounded-lg border border-[#d9dbff] bg-white px-2.5 py-2 text-xs text-[#4f4a91]">
                  <div className="font-semibold text-[#362f7c]">
                    {hoverEntity.entity.name}
                  </div>
                  <div className="text-[#6e69ac]">
                    {hoverEntity.entity.entityType.toUpperCase()} • {hoverEntity.entity.id}
                  </div>
                  <div className="mt-1 text-[#6e69ac]">
                    {hoverEntity.entity.description ?? "Canonical entity metadata not provided."}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="text-xs text-[#6d68ac]">
              Matching uses semantic extraction + ontology search. It avoids alpha/beta family swaps.
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/94 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Run profile
            </div>

            <div className="space-y-2">
              {(["fast", "balanced", "deep"] as RunMode[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
                    mode === item
                      ? "border-[#5b57e6] bg-[#ebe8ff] text-[#352f79]"
                      : "border-[#ddd9ff] bg-[#f7f5ff] text-[#4d4890]"
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
                  <div className="mt-0.5 text-xs text-[#6863aa]">{modeDescription[item]}</div>
                </button>
              ))}
            </div>

            <Button
              className="h-11 w-full bg-[#5b57e6] text-white hover:bg-[#4941ce]"
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
