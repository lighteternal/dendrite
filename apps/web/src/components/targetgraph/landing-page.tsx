"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search, Sparkles } from "lucide-react";
import { APP_QUESTION, PRESET_DISEASES } from "@/components/targetgraph/constants";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type RunMode = "fast" | "balanced" | "deep";

type DiseaseSuggestion = {
  id: string;
  name: string;
  description?: string;
};

type SuggestResponse = {
  results: DiseaseSuggestion[];
};

const modeDescription: Record<RunMode, string> = {
  fast: "Fast first-pass mechanism brief.",
  balanced: "Default depth with interaction context.",
  deep: "Full-depth run including literature/trials.",
};

export function LandingPage() {
  const router = useRouter();

  const [query, setQuery] = useState(
    "For Alzheimer's disease, what target-pathway-drug mechanism appears most actionable with strong evidence?",
  );
  const [mode, setMode] = useState<RunMode>("balanced");

  const [diseaseInput, setDiseaseInput] = useState("");
  const [diseaseSuggestions, setDiseaseSuggestions] = useState<DiseaseSuggestion[]>([]);
  const [selectedDisease, setSelectedDisease] = useState<DiseaseSuggestion | null>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);

  useEffect(() => {
    if (selectedDisease && diseaseInput.trim() !== selectedDisease.name) {
      setSelectedDisease(null);
    }
  }, [diseaseInput, selectedDisease]);

  useEffect(() => {
    const trimmed = diseaseInput.trim();
    if (trimmed.length < 2) {
      setDiseaseSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsSuggesting(true);
      try {
        const response = await fetch(
          `/api/suggestDisease?query=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        const payload = (await response.json()) as SuggestResponse;
        setDiseaseSuggestions(payload.results ?? []);
      } catch {
        setDiseaseSuggestions([]);
      } finally {
        setIsSuggesting(false);
      }
    }, 140);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [diseaseInput]);

  const runDisabled = useMemo(() => query.trim().length < 8, [query]);

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
              Translational mechanism brief
            </Badge>
          </div>

          <h1 className="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-[#2a2574] md:text-6xl">
            Ask one disease question. Get one evidence-anchored mechanism brief.
          </h1>

          <p className="max-w-4xl text-sm leading-7 text-[#3d3a7e] md:text-base">
            {APP_QUESTION}
          </p>

          <div className="inline-flex rounded-full border border-[#f2c38b] bg-[#fff6e8] px-4 py-2 text-xs font-medium text-[#9a5510]">
            Research evidence summary — not clinical guidance.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Question
            </div>

            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Example: For rheumatoid arthritis refractory to TNF inhibitors, what pathway-target-drug thread looks most tractable?"
              className="min-h-[136px] w-full resize-y rounded-xl border border-[#c5c7fc] bg-[#f7f7ff] px-3 py-2.5 text-sm text-[#221f62] outline-none ring-[#5b57e6] placeholder:text-[#6e6aa9] focus:ring-2"
            />

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6f69af]">
                Optional disease pin (fast autocomplete)
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6a66b4]" />
                <input
                  value={diseaseInput}
                  onChange={(event) => setDiseaseInput(event.target.value)}
                  placeholder="Type disease name to lock entity (optional)"
                  className="h-11 w-full rounded-xl border border-[#c5c7fc] bg-[#f7f7ff] pl-9 pr-3 text-sm text-[#221f62] outline-none ring-[#5b57e6] placeholder:text-[#6e6aa9] focus:ring-2"
                />
              </div>

              {isSuggesting ? (
                <div className="text-xs text-[#6e69ac]">Searching disease entities...</div>
              ) : null}

              {diseaseSuggestions.length > 0 && diseaseInput.trim().length >= 2 ? (
                <div className="max-h-[180px] overflow-auto rounded-xl border border-[#d9dbff] bg-[#f8f8ff] p-1.5">
                  {diseaseSuggestions.slice(0, 8).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setSelectedDisease(item);
                        setDiseaseInput(item.name);
                        setDiseaseSuggestions([]);
                      }}
                      className={`mb-1 block w-full rounded-lg border px-2.5 py-2 text-left text-xs ${
                        selectedDisease?.id === item.id
                          ? "border-[#5b57e6] bg-[#ebe8ff] text-[#3a347f]"
                          : "border-[#e0dcff] bg-white text-[#4f4a91] hover:bg-[#f2f0ff]"
                      }`}
                    >
                      <div className="font-semibold">{item.name}</div>
                      <div className="mt-0.5 text-[11px] text-[#736eaf]">{item.id}</div>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="text-xs text-[#6d68ac]">
                Submit anytime. Disease entity resolution happens during the streamed run.
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {PRESET_DISEASES.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="rounded-full border border-[#cfccff] bg-[#f1efff] px-3 py-1 text-xs font-medium text-[#3a347f] transition hover:-translate-y-0.5 hover:bg-[#e7e2ff]"
                  onClick={() => {
                    setQuery(`For ${item}, what mechanism thread is strongest from disease to target to drug?`);
                    setDiseaseInput(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
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
                  <div className="font-semibold capitalize">{item}</div>
                  <div className="mt-0.5 text-xs text-[#6863aa]">{modeDescription[item]}</div>
                </button>
              ))}
            </div>

            <Button
              className="h-11 w-full bg-[#5b57e6] text-white hover:bg-[#4941ce]"
              onClick={run}
              disabled={runDisabled}
            >
              Run decision brief <ArrowRight className="ml-1 h-4 w-4" />
            </Button>

            <div className="rounded-xl border border-[#f3d1ab] bg-[#fff7ec] p-3 text-xs text-[#8a4e16]">
              You get one ranked recommendation thread with explicit caveats, alternatives, and evidence references.
            </div>
          </aside>
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#5049ad]">
              <Sparkles className="h-4 w-4" />
              <div className="text-sm font-semibold">While it runs</div>
            </div>
            <p className="text-xs leading-6 text-[#464187]">
              The app streams each phase in plain language: entity resolution, target enrichment, pathway/drug traversal, interaction context, and ranking.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#f3d1ab] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-[#b36218]">What you can export</div>
            <p className="text-xs leading-6 text-[#5c4a3a]">
              A decision brief JSON with recommendation, evidence trace, caveats, and next experiments for team review.
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
