"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FlaskConical, Microscope, Search, Sparkles } from "lucide-react";
import { APP_QUESTION, PRESET_DISEASES } from "@/components/targetgraph/constants";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type DiseaseSuggestion = {
  id: string;
  name: string;
  description?: string;
};

export function LandingPage() {
  const router = useRouter();

  const [disease, setDisease] = useState("Alzheimer's disease");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<DiseaseSuggestion[]>([]);
  const [selectedDiseaseId, setSelectedDiseaseId] = useState<string | null>(null);
  const [pathways, setPathways] = useState(true);
  const [drugs, setDrugs] = useState(true);
  const [interactions, setInteractions] = useState(false);
  const [literature, setLiterature] = useState(false);

  useEffect(() => {
    if (!query || query.length < 2) return;

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/suggestDisease?query=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const json = (await response.json()) as { results: DiseaseSuggestion[] };
        setSuggestions(json.results ?? []);
      } catch {
        // no-op
      }
    }, 160);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [query]);

  const chips = useMemo(() => PRESET_DISEASES, []);

  const build = () => {
    const cleaned = disease.trim();
    if (!cleaned) return;

    const params = new URLSearchParams({
      disease: cleaned,
      pathways: pathways ? "1" : "0",
      drugs: drugs ? "1" : "0",
      interactions: interactions ? "1" : "0",
      literature: literature ? "1" : "0",
    });

    if (selectedDiseaseId) {
      params.set("diseaseId", selectedDiseaseId);
    }

    router.push(`/graph?${params.toString()}`);
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pb-14 pt-10 md:px-8 md:pt-14">
        <header className="tg-panel-rise space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-[#5b57e6] px-3 py-1 text-white">TargetGraph</Badge>
            <Badge className="rounded-full border border-[#c6c3ff] bg-white/88 text-[#332c89]">
              Biology-first discovery workspace
            </Badge>
          </div>
          <h1 className="max-w-5xl text-4xl font-semibold leading-tight tracking-tight text-[#2a2574] md:text-6xl">
            Biology-first disease-to-target decision workspace
          </h1>
          <p className="max-w-4xl text-sm leading-7 text-[#3d3a7e] md:text-base">{APP_QUESTION}</p>
          <div className="inline-flex rounded-full border border-[#f2c38b] bg-[#fff6e8] px-4 py-2 text-xs font-medium text-[#9a5510]">
            Research evidence summary — not clinical guidance.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.2fr_0.9fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Start a case
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6a66b4]" />
              <Input
                value={disease}
                onChange={(event) => {
                  const next = event.target.value;
                  setDisease(next);
                  setQuery(next);
                  setSelectedDiseaseId(null);
                  if (next.length < 2) {
                    setSuggestions([]);
                  }
                }}
                placeholder="Type disease (e.g., non-small cell lung cancer)"
                className="h-11 border-[#c5c7fc] bg-[#f7f7ff] pl-9 text-[#221f62] placeholder:text-[#6e6aa9]"
              />
            </div>

            <div className="rounded-xl border border-[#d9dbff] bg-[#f8f8ff] p-2">
              <div className="mb-1 text-[11px] font-medium text-[#6f69af]">
                Disease-only entity matching (EFO / MONDO / ORPHANET / DOID)
              </div>
              <div className="max-h-[190px] overflow-auto rounded-lg border border-[#e1ddff] bg-white">
                {suggestions.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-[#7c76b9]">
                    {query.length < 2
                      ? "Type at least 2 characters to search disease entities."
                      : "No disease suggestions yet."}
                  </div>
                ) : (
                  <div className="divide-y divide-[#ece9ff]">
                    {suggestions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-[#f5f2ff]"
                        onClick={() => {
                          setDisease(item.name);
                          setQuery(item.name);
                          setSelectedDiseaseId(item.id);
                        }}
                      >
                        <span className="text-sm text-[#2d2a73]">{item.name}</span>
                        <span className="shrink-0 text-[11px] text-[#7a77b1]">{item.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="rounded-full border border-[#cfccff] bg-[#f1efff] px-3 py-1 text-xs font-medium text-[#3a347f] transition hover:-translate-y-0.5 hover:bg-[#e7e2ff]"
                  onClick={() => {
                    setDisease(chip);
                    setQuery(chip);
                    setSelectedDiseaseId(null);
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#cecfff] bg-white/92 p-5 shadow-[0_20px_80px_rgba(75,56,158,0.14)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#5550a5]">
              Build Profile
            </div>
            <div className="space-y-2 rounded-xl border border-[#ddd9ff] bg-[#f7f5ff] p-4 text-sm text-[#2f2a70]">
              <div className="flex items-center justify-between">
                <span>Pathways</span>
                <Switch checked={pathways} onCheckedChange={setPathways} />
              </div>
              <div className="flex items-center justify-between">
                <span>Drugs</span>
                <Switch checked={drugs} onCheckedChange={setDrugs} />
              </div>
              <div className="flex items-center justify-between">
                <span>Interactions</span>
                <Switch checked={interactions} onCheckedChange={setInteractions} />
              </div>
              <div className="flex items-center justify-between">
                <span>Literature / Trials</span>
                <Switch checked={literature} onCheckedChange={setLiterature} />
              </div>
            </div>
            <div className="rounded-xl border border-[#f3d1ab] bg-[#fff7ec] p-4 text-xs text-[#8a4e16]">
              Fast start: pathways + drugs. Add interactions/literature when you need mechanistic depth.
            </div>
            <Button
              className="h-11 w-full bg-[#5b57e6] text-white hover:bg-[#4941ce]"
              onClick={build}
            >
              Build live network <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </aside>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#5049ad]">
              <Microscope className="h-4 w-4" />
              <div className="text-sm font-semibold">Biologist Workflow</div>
            </div>
            <p className="text-xs leading-6 text-[#464187]">
              Move from disease term to ranked targets, pathways, compounds, and interaction context in one
              continuously updating graph.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#d3d5ff] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#5b57e6]">
              <Sparkles className="h-4 w-4" />
              <div className="text-sm font-semibold">Decision Support</div>
            </div>
            <p className="text-xs leading-6 text-[#464187]">
              Hypothesis mode constrains recommendations to observed evidence fields and returns explicit caveats
              when inputs are missing.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#f3d1ab] bg-white/88 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#b36218]">
              <FlaskConical className="h-4 w-4" />
              <div className="text-sm font-semibold">Exportable Outputs</div>
            </div>
            <p className="text-xs leading-6 text-[#5c4a3a]">
              Capture network screenshots, export graph JSON, and keep explainable summaries for program review.
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
