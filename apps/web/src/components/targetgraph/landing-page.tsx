"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { challengeQueries } from "@/components/targetgraph/challenge-queries";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function LandingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const canRun = query.trim().length >= 6;

  const run = () => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 6) return;
    router.push(`/brief?query=${encodeURIComponent(trimmedQuery)}`);
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-12 pt-10 md:px-8 md:pt-14">
        <header className="tg-panel-rise rounded-2xl border border-[#d8e2f3] bg-white/94 p-6 shadow-[0_26px_90px_rgba(38,69,116,0.12)] backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-[#2f5ca4] px-3 py-1 text-white">TargetGraph</Badge>
            <Badge className="rounded-full border border-[#d6e1f3] bg-[#f6f9ff] text-[#45618c]">
              Multi-hop biomedical search
            </Badge>
          </div>

          <h1 className="max-w-4xl text-3xl font-semibold leading-tight tracking-tight text-[#223861] md:text-5xl">
            Ask a biomedical question and watch a live multihop mechanism search unfold in real time.
          </h1>

          <p className="mt-3 max-w-4xl text-sm leading-7 text-[#516a8f] md:text-base">
            After submission, TargetGraph resolves canonical entities, runs multichannel evidence retrieval with agent-led follow-ups,
            and streams the evolving discovery journey and graph updates together.
          </p>

          <div className="mt-4 inline-flex rounded-full border border-[#dbe4f2] bg-[#f6f9ff] px-4 py-2 text-xs font-medium text-[#4c668f]">
            Mode: Multi-hop Search (full evidence pass).
          </div>
        </header>

        <section className="tg-panel-rise rounded-2xl border border-[#d8e2f3] bg-white/95 p-5 shadow-[0_24px_80px_rgba(38,69,116,0.1)] backdrop-blur">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#5a759f]">Query</div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6784b2]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") run();
              }}
              placeholder="e.g. what is the connection between alopecia and weight loss"
              className="h-12 w-full rounded-xl border border-[#d6e1f2] bg-[#f9fbff] pl-9 pr-3 text-sm text-[#22385c] outline-none ring-[#2f5ca4] placeholder:text-[#738bab] focus:ring-2"
            />
          </div>

          <div className="mt-3 rounded-xl border border-[#dbe4f2] bg-[#f7faff] p-3 text-xs leading-6 text-[#54719a]">
            We wait until you press <span className="font-semibold">Generate brief</span> before resolving entities or building autocomplete cues.
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {challengeQueries.slice(0, 10).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setQuery(item)}
                className="rounded-full border border-[#d6e1f3] bg-white px-2.5 py-1 text-[11px] text-[#4f698f] hover:bg-[#f4f8ff]"
              >
                {item}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#5c7599]">
              Expect deeper evidence collection with multi-agent follow-ups, which typically takes 30-90 seconds.
            </div>
            <Button className="h-11 bg-[#2f5ca4] text-white hover:bg-[#264b86]" onClick={run} disabled={!canRun}>
              Generate brief <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </section>

        <footer className="border-t border-[#d8e2f3] pt-4 text-[11px] text-[#5f7598]">
          Preclinical evidence synthesis only; not for clinical decision-making.
        </footer>
      </div>
    </main>
  );
}
