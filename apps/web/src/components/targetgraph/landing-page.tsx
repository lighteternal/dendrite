"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
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
  const [interactions, setInteractions] = useState(true);
  const [literature, setLiterature] = useState(true);

  useEffect(() => {
    if (!query || query.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/suggestDisease?query=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const json = (await response.json()) as { results: DiseaseSuggestion[] };
        setSuggestions(json.results ?? []);
      } catch {
        // noop
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
    <main className="relative min-h-screen overflow-hidden bg-[#050910] text-[#dfefff]">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-24 top-0 h-96 w-96 rounded-full bg-[#123f80]/40 blur-3xl" />
        <div className="absolute right-[-80px] top-16 h-96 w-96 rounded-full bg-[#c94f2d]/30 blur-3xl" />
        <div className="absolute bottom-[-100px] left-1/3 h-[420px] w-[420px] rounded-full bg-[#1c6e5f]/25 blur-3xl" />
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col gap-8 px-4 pb-14 pt-14 md:px-8">
        <header className="space-y-4">
          <Badge className="rounded-sm bg-[#12213a] text-cyan-100">TargetGraph</Badge>
          <h1 className="max-w-4xl text-3xl font-semibold leading-tight tracking-tight md:text-5xl">
            Disease → Target → Drug → Pathway systems graph with decision-grade hypothesis mode
          </h1>
          <p className="max-w-4xl text-sm leading-6 text-[#b5cbe0] md:text-base">{APP_QUESTION}</p>
          <div className="rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
            Research evidence summary — not clinical guidance.
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
          <div className="space-y-3 rounded-xl border border-white/10 bg-[#0d1521]/90 p-4 backdrop-blur">
            <div className="text-xs uppercase tracking-[0.2em] text-[#88a8c6]">Disease Search</div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[#7e9bb8]" />
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
                placeholder="Type a disease"
                className="pl-9"
              />
            </div>

            <div className="rounded-md border border-white/10 bg-[#101a2a]">
              <Command className="bg-transparent">
                <CommandInput
                  placeholder="Typeahead command palette"
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
                  <CommandGroup heading="OpenTargets suggestions">
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
                          <span>{item.name}</span>
                          <span className="text-[11px] text-[#8ea6bf]">{item.id}</span>
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
                  className="rounded-full border border-white/15 bg-[#17263a] px-3 py-1 text-xs text-[#d9edff] transition hover:bg-[#223753]"
                  onClick={() => {
                    setDisease(chip);
                    setQuery(chip);
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-white/10 bg-[#0d1521]/90 p-4 backdrop-blur">
            <div className="text-xs uppercase tracking-[0.2em] text-[#88a8c6]">Build Options</div>
            <div className="space-y-2 rounded-md bg-[#152236] p-3 text-sm text-[#d8ebff]">
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

            <Button className="h-11 w-full bg-[#f77f00] text-black hover:bg-[#ff9d33]" onClick={build}>
              Build live network
            </Button>
          </div>
        </section>

        <footer className="space-y-1 border-t border-white/10 pt-4 text-[11px] text-[#7f9bb6]">
          <div>
            Open Targets GraphQL endpoint: <a className="underline" href="https://api.platform.opentargets.org/api/v4/graphql" target="_blank" rel="noreferrer">https://api.platform.opentargets.org/api/v4/graphql</a>
          </div>
          <div>
            Reactome Content Service (current supported API): <a className="underline" href="https://reactome.org/ContentService/" target="_blank" rel="noreferrer">https://reactome.org/ContentService/</a>
          </div>
        </footer>
      </div>
    </main>
  );
}
