"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FlaskConical, Search, Sparkles, Workflow } from "lucide-react";
import { APP_QUESTION, PRESET_DISEASES } from "@/components/targetgraph/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
    }, 180);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [query]);

  const chips = useMemo(() => PRESET_DISEASES, []);

  const build = () => {
    if (!disease.trim()) return;

    const url =
      `/graph?disease=${encodeURIComponent(disease.trim())}` +
      `&pathways=${pathways ? 1 : 0}` +
      `&drugs=${drugs ? 1 : 0}` +
      `&interactions=${interactions ? 1 : 0}` +
      `&literature=${literature ? 1 : 0}`;

    router.push(url);
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_15%,rgba(44,109,255,0.16),transparent_35%),radial-gradient(circle_at_85%_10%,rgba(14,164,154,0.18),transparent_34%),radial-gradient(circle_at_50%_95%,rgba(15,76,129,0.12),transparent_35%)]" />

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 pb-14 pt-10 md:px-8 md:pt-14">
        <header className="tg-panel-rise space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-[#1a56db] px-3 py-1 text-white">TargetGraph</Badge>
            <Badge className="rounded-full border border-[#8db4ff] bg-white/90 text-[#16315f]">
              Decision-grade translational search
            </Badge>
          </div>
          <h1 className="max-w-5xl text-4xl font-semibold leading-tight tracking-tight text-[#13294b] md:text-6xl">
            Disease to mechanism, target, and tractable intervention in one live workspace
          </h1>
          <p className="max-w-4xl text-sm leading-7 text-[#2f4f73] md:text-base">{APP_QUESTION}</p>
          <div className="inline-flex rounded-full border border-[#f2cd80] bg-[#fff9ec] px-4 py-2 text-xs font-medium text-[#825300]">
            Research evidence summary — not clinical guidance.
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.2fr_0.9fr]">
          <article className="tg-panel-rise space-y-4 rounded-2xl border border-[#c8dbf7] bg-white/95 p-5 shadow-[0_20px_60px_rgba(15,54,96,0.08)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#3d628d]">
              Start A Case
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#5a7ea7]" />
              <Input
                value={disease}
                onChange={(event) => {
                  const next = event.target.value;
                  setDisease(next);
                  setQuery(next);
                  if (next.length < 2) {
                    setSuggestions([]);
                  }
                }}
                placeholder="Type disease (e.g., non-small cell lung cancer)"
                className="h-11 border-[#bfd4f3] bg-[#f8fbff] pl-9 text-[#0f2a4d] placeholder:text-[#6986a8]"
              />
            </div>

            <div className="rounded-xl border border-[#d4e2f7] bg-[#f8fbff]">
              <Command className="bg-transparent">
                <CommandInput
                  placeholder="Command-style typeahead"
                  value={query}
                  onValueChange={(value) => {
                    setQuery(value);
                    if (value.length < 2) {
                      setSuggestions([]);
                    }
                  }}
                />
                <CommandList>
                  <CommandEmpty>No disease suggestions yet.</CommandEmpty>
                  <CommandGroup heading="OpenTargets disease matches">
                    {suggestions.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={item.name}
                        onSelect={() => {
                          setDisease(item.name);
                          setQuery(item.name);
                        }}
                        className="cursor-pointer"
                      >
                        <div className="flex flex-col">
                          <span className="text-[#19365f]">{item.name}</span>
                          <span className="text-[11px] text-[#6784a5]">{item.id}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>

            <div className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="rounded-full border border-[#c7daf7] bg-[#eef5ff] px-3 py-1 text-xs font-medium text-[#21436d] transition hover:-translate-y-0.5 hover:bg-[#deebff]"
                  onClick={() => {
                    setDisease(chip);
                    setQuery(chip);
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </article>

          <aside className="tg-panel-rise space-y-4 rounded-2xl border border-[#c8dbf7] bg-white/95 p-5 shadow-[0_20px_60px_rgba(15,54,96,0.08)] backdrop-blur">
            <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[#3d628d]">
              Build Profile
            </div>
            <div className="space-y-2 rounded-xl border border-[#d5e5fb] bg-[#f6faff] p-4 text-sm text-[#1f4068]">
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
            <div className="rounded-xl border border-[#d5e5fb] bg-[#f6faff] p-4 text-xs text-[#31557f]">
              Default run favors fast core graph. Enable interactions/literature when you need depth.
            </div>
            <Button
              className="h-11 w-full bg-[#1357d5] text-white hover:bg-[#0f46ad]"
              onClick={build}
            >
              Build live network <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </aside>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="tg-panel-rise rounded-2xl border border-[#c9dcf8] bg-white/90 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#1b4ea5]">
              <Workflow className="h-4 w-4" />
              <div className="text-sm font-semibold">What You Get</div>
            </div>
            <p className="text-xs leading-6 text-[#2f4f73]">
              A live systems graph linking disease, top targets, pathways, compounds, and interaction
              context with deterministic IDs and evidence scores.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#c9dcf8] bg-white/90 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#087a70]">
              <Sparkles className="h-4 w-4" />
              <div className="text-sm font-semibold">Why It Matters</div>
            </div>
            <p className="text-xs leading-6 text-[#2f4f73]">
              Hypothesis mode converts the graph into a decision cockpit: pathway-scoped target ranking,
              mechanism thread, caveats, and missing-input disclosure.
            </p>
          </div>
          <div className="tg-panel-rise rounded-2xl border border-[#c9dcf8] bg-white/90 p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-2 text-[#9a5800]">
              <FlaskConical className="h-4 w-4" />
              <div className="text-sm font-semibold">How Teams Use It</div>
            </div>
            <p className="text-xs leading-6 text-[#2f4f73]">
              Build a case, inspect evidence, generate a mechanism narrative, compare alternatives, and
              export graph JSON or screenshot for review.
            </p>
          </div>
        </section>

        <footer className="space-y-1 border-t border-[#cdddf4] pt-4 text-[11px] text-[#5f7da1]">
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
