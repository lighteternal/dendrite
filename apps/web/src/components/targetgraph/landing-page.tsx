"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Microscope,
  Search,
  Workflow,
} from "lucide-react";
import { APP_QUESTION, PRESET_DISEASES } from "@/components/targetgraph/constants";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

type RunMode = "fast" | "balanced" | "deep";

type DiseaseCandidate = {
  id: string;
  name: string;
  description?: string;
};

type ResolveResponse = {
  query: string;
  selected: DiseaseCandidate | null;
  candidates: DiseaseCandidate[];
  rationale: string;
};

const modeDescription: Record<RunMode, string> = {
  fast: "Fast first pass: shortest time to a decision-grade mechanism thread.",
  balanced: "Balanced: adds interaction context for stronger mechanistic plausibility.",
  deep: "Deep: full context including literature/trials and denser neighborhoods.",
};

export function LandingPage() {
  const router = useRouter();

  const [useKeywordInput, setUseKeywordInput] = useState(false);
  const [mode, setMode] = useState<RunMode>("balanced");

  const [nlQuery, setNlQuery] = useState(
    "For Alzheimer's disease, what target-pathway-drug mechanism appears most actionable with strong evidence?",
  );
  const [keywordQuery, setKeywordQuery] = useState("Alzheimer's disease");

  const [resolver, setResolver] = useState<ResolveResponse | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [resolverError, setResolverError] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const activeQuery = useMemo(
    () => (useKeywordInput ? keywordQuery.trim() : nlQuery.trim()),
    [keywordQuery, nlQuery, useKeywordInput],
  );

  useEffect(() => {
    if (!activeQuery || activeQuery.length < 2) {
      setResolver(null);
      setSelectedCandidateId(null);
      return;
    }

    const controller = new AbortController();
    setResolverError(null);

    const timeout = setTimeout(async () => {
      setIsResolving(true);
      try {
        const response = await fetch(`/api/resolveDisease?query=${encodeURIComponent(activeQuery)}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`resolver error ${response.status}`);
        }

        const payload = (await response.json()) as ResolveResponse;
        setResolver(payload);
        setSelectedCandidateId(payload.selected?.id ?? payload.candidates[0]?.id ?? null);
      } catch {
        setResolverError("Disease resolver unavailable. You can still run with keyword mode.");
      } finally {
        setIsResolving(false);
      }
    }, 240);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [activeQuery]);

  const selectedCandidate = useMemo(() => {
    if (!resolver?.candidates?.length) return resolver?.selected ?? null;
    return (
      resolver.candidates.find((item) => item.id === selectedCandidateId) ??
      resolver.selected ??
      resolver.candidates[0] ??
      null
    );
  }, [resolver, selectedCandidateId]);

  const canRun = Boolean(activeQuery && selectedCandidate);

  const run = () => {
    if (!canRun || !selectedCandidate) return;

    const params = new URLSearchParams({
      query: selectedCandidate.name,
      diseaseId: selectedCandidate.id,
      mode,
    });

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
              Decision-grade translational brief
            </Badge>
          </div>

          <h1 className="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-[#2a2574] md:text-6xl">
            One question in, one mechanism decision brief out
          </h1>

          <p className="max-w-4xl text-sm leading-7 text-[#3d3a7e] md:text-base">{APP_QUESTION}</p>

          <div className="inline-flex rounded-full border border-[#f2c38b] bg-[#fff6e8] px-4 py-2 text-xs font-medium text-[#9a5510]">
            Research evidence summary — not clinical guidance.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
                Ask Your Question
              </div>
              <div className="flex items-center gap-2 text-xs text-[#5f5aa0]">
                <span>Natural language</span>
                <Switch checked={useKeywordInput} onCheckedChange={setUseKeywordInput} />
                <span>Keyword mode</span>
              </div>
            </div>

            {!useKeywordInput ? (
              <textarea
                value={nlQuery}
                onChange={(event) => setNlQuery(event.target.value)}
                placeholder="Example: For rheumatoid arthritis refractory to TNF inhibitors, what pathway-target-drug thread looks most tractable?"
                className="min-h-[130px] w-full resize-y rounded-xl border border-[#c5c7fc] bg-[#f7f7ff] px-3 py-2.5 text-sm text-[#221f62] outline-none ring-[#5b57e6] placeholder:text-[#6e6aa9] focus:ring-2"
              />
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6a66b4]" />
                  <input
                    value={keywordQuery}
                    onChange={(event) => setKeywordQuery(event.target.value)}
                    placeholder="Type a disease keyword"
                    className="h-11 w-full rounded-xl border border-[#c5c7fc] bg-[#f7f7ff] pl-9 pr-3 text-sm text-[#221f62] outline-none ring-[#5b57e6] placeholder:text-[#6e6aa9] focus:ring-2"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {PRESET_DISEASES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="rounded-full border border-[#cfccff] bg-[#f1efff] px-3 py-1 text-xs font-medium text-[#3a347f] transition hover:-translate-y-0.5 hover:bg-[#e7e2ff]"
                      onClick={() => setKeywordQuery(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-[#ddd9ff] bg-[#f8f8ff] p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6f69af]">
                <CheckCircle2 className="h-3.5 w-3.5" /> Disease entity confirmation
              </div>

              {isResolving ? (
                <div className="text-xs text-[#6f6aad]">Resolving disease entity...</div>
              ) : resolverError ? (
                <div className="text-xs text-[#9a5614]">{resolverError}</div>
              ) : selectedCandidate ? (
                <>
                  <div className="rounded-lg border border-[#d9dbff] bg-white px-2.5 py-2 text-xs text-[#514b95]">
                    <div className="font-semibold text-[#3a347f]">Matched entity: {selectedCandidate.name}</div>
                    <div className="text-[#6d68ad]">{selectedCandidate.id}</div>
                    <div className="mt-1 text-[#6d68ad]">{resolver?.rationale}</div>
                  </div>

                  {resolver?.candidates?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {resolver.candidates.slice(0, 8).map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          className={`rounded-full border px-2.5 py-1 text-[11px] ${
                            selectedCandidateId === candidate.id
                              ? "border-[#5b57e6] bg-[#ebe8ff] text-[#3a347f]"
                              : "border-[#d6d1ff] bg-white text-[#5e599d]"
                          }`}
                          onClick={() => setSelectedCandidateId(candidate.id)}
                        >
                          {candidate.name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-xs text-[#7d78b7]">Type your question to resolve disease entity candidates.</div>
              )}
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Run Profile
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
                  <div className="font-semibold capitalize">{item}</div>
                  <div className="mt-0.5 text-xs text-[#6863aa]">{modeDescription[item]}</div>
                </button>
              ))}
            </div>

            <Button
              className="h-11 w-full bg-[#5b57e6] text-white hover:bg-[#4941ce]"
              onClick={run}
              disabled={!canRun}
            >
              Run Decision Brief <ArrowRight className="ml-1 h-4 w-4" />
            </Button>

            <div className="rounded-xl border border-[#f3d1ab] bg-[#fff7ec] p-3 text-xs text-[#8a4e16]">
              The app will stream each step live and show one recommendation thread with explicit caveats and next experiments.
            </div>
          </aside>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#5049ad]">
              <Workflow className="h-4 w-4" />
              <div className="text-sm font-semibold">1. Resolve and Traverse</div>
            </div>
            <p className="text-xs leading-6 text-[#464187]">
              Disease entity resolution, then live MCP traversal from disease to targets, pathways, compounds, and interactions.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#5b57e6]">
              <BrainCircuit className="h-4 w-4" />
              <div className="text-sm font-semibold">2. Decide with Evidence</div>
            </div>
            <p className="text-xs leading-6 text-[#464187]">
              One mechanism recommendation with explainable evidence references, alternatives, and explicit data caveats.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#f3d1ab] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#b36218]">
              <Microscope className="h-4 w-4" />
              <div className="text-sm font-semibold">3. Act and Export</div>
            </div>
            <p className="text-xs leading-6 text-[#5c4a3a]">
              Export an interactive brief JSON for review and follow-up experiments. No clinical claims are made.
            </p>
          </div>
        </section>

        <footer className="space-y-1 border-t border-[#ddd9ff] pt-4 text-[11px] text-[#625ea2]">
          <div>
            Open Targets GraphQL endpoint: {" "}
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
            Reactome Content Service (current supported API): {" "}
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
