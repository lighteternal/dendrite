"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { LandingMoleculeBackground } from "@/components/targetgraph/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const SAMPLE_QUERIES = [
  "What targets and pathways connect ALS to oxidative stress?",
  "How might obesity lead to type 2 diabetes through inflammatory signaling?",
  "Which mechanistic path could connect lupus, IL-6 signaling, and obesity?",
] as const;
const EXAMPLE_QUERY = "What targets and pathways connect ALS to oxidative stress?";

const LIVE_WORDS = ["live.", "discover.", "answer evidence-first."] as const;

export function LandingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [isPersistingKey, setIsPersistingKey] = useState(false);
  const [headerTab, setHeaderTab] = useState<"agent" | "tools">("agent");
  const [liveWordIndex, setLiveWordIndex] = useState(0);
  const [typedLiveWord, setTypedLiveWord] = useState("");
  const [isDeletingLiveWord, setIsDeletingLiveWord] = useState(false);

  useEffect(() => {
    const currentWord = LIVE_WORDS[liveWordIndex] ?? LIVE_WORDS[0];
    let timer: ReturnType<typeof setTimeout>;

    if (!isDeletingLiveWord && typedLiveWord.length < currentWord.length) {
      timer = setTimeout(() => {
        setTypedLiveWord(currentWord.slice(0, typedLiveWord.length + 1));
      }, 64);
    } else if (!isDeletingLiveWord && typedLiveWord.length === currentWord.length) {
      timer = setTimeout(() => {
        setIsDeletingLiveWord(true);
      }, 1050);
    } else if (isDeletingLiveWord && typedLiveWord.length > 0) {
      timer = setTimeout(() => {
        setTypedLiveWord(currentWord.slice(0, typedLiveWord.length - 1));
      }, 42);
    } else {
      timer = setTimeout(() => {
        setIsDeletingLiveWord(false);
        setLiveWordIndex((index) => (index + 1) % LIVE_WORDS.length);
      }, 240);
    }

    return () => clearTimeout(timer);
  }, [isDeletingLiveWord, liveWordIndex, typedLiveWord]);

  const hasApiKey = apiKey.trim().length > 0;
  const canRun = query.trim().length >= 6 && hasApiKey;

  const resolveSessionId = () => {
    if (typeof window === "undefined") return "landing-session";
    const storageKey = "targetgraph_session_id";
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const generated =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    window.localStorage.setItem(storageKey, generated);
    return generated;
  };

  const persistSessionApiKey = async () => {
    const sessionId = resolveSessionId();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await fetch(`/api/runCaseStream?action=clear_api_key&sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
      });
      return;
    }

    const response = await fetch(
      `/api/runCaseStream?action=set_api_key&sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: trimmed }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      const message =
        payload?.error === "invalid_api_key_format"
          ? "Invalid key format. Expected shape: sk-xxxxxxxxxxxx"
          : "Could not apply API key for this session.";
      throw new Error(message);
    }
  };

  const runWithQuery = async (
    inputQuery: string,
    options?: {
      allowEmptyKey?: boolean;
    },
  ) => {
    const trimmedQuery = inputQuery.trim();
    if (trimmedQuery.length < 6) return;
    const allowEmptyKey = options?.allowEmptyKey ?? false;
    if (!allowEmptyKey && !hasApiKey) {
      setApiKeyError("Enter your OpenAI API key to run a custom query.");
      return;
    }
    setApiKeyError(null);
    setIsPersistingKey(true);
    try {
      await persistSessionApiKey();
      router.push(`/brief?query=${encodeURIComponent(trimmedQuery)}`);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not start run.");
    } finally {
      setIsPersistingKey(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pb-12 pt-8 md:px-8 md:pt-12">
        <header className="tg-panel-rise rounded-3xl border border-[#d8e5f3] bg-white/90 p-6 shadow-[0_36px_120px_rgba(18,52,88,0.14)] backdrop-blur md:p-8">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="rounded-full bg-[#235f8f] px-3 py-1 text-white">TargetGraph</Badge>
              <Badge className="rounded-full border border-[#d6e5f3] bg-[#f5faff] text-[#38658e]">
                Agentic biomedical discovery
              </Badge>
            </div>
            <div className="min-w-[280px] flex-1 sm:max-w-[360px]">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#55759a]">
                OpenAI API key
              </div>
              <input
                suppressHydrationWarning
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxx"
                className="h-9 w-full rounded-lg border border-[#d7e5f3] bg-white px-3 text-sm text-[#244062] outline-none ring-[#2f7ab3] placeholder:text-[#8094b4] focus:ring-2"
              />
              <div className="mt-1 text-[11px] text-[#5e7698]">
                Enter your key for live runs. We never store it as footprint.
              </div>
            </div>
          </div>

          <h1 className="max-w-4xl text-3xl font-semibold leading-tight tracking-tight text-[#17355f] md:text-5xl">
            Trace multi-hop, mechanism-level links across diseases, targets, pathways, and interventions.
          </h1>

          <p className="mt-3 max-w-4xl text-sm leading-7 text-[#4b6b8f] md:text-base">
            Agentic AI explores competing multihop hypotheses, keeps every tested branch visible and converges on a
            citation-backed biological answer. Watch it{" "}
            <span className="inline-flex min-w-[16ch] items-center font-semibold text-[#1e5f95]">
              {typedLiveWord || " "}
              <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-[#1e5f95]" />
            </span>
          </p>

          <div className="mt-4 rounded-2xl border border-[#d8e5f3] bg-[#f7fbff]">
            <div className="flex flex-wrap gap-1 border-b border-[#d8e5f3] p-1">
              <button
                type="button"
                onClick={() => setHeaderTab("agent")}
                className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                  headerTab === "agent"
                    ? "bg-white text-[#1f5f95] shadow-[0_10px_24px_rgba(34,90,141,0.15)]"
                    : "text-[#567499] hover:bg-white/70"
                }`}
              >
                LangGraph Agent
              </button>
              <button
                type="button"
                onClick={() => setHeaderTab("tools")}
                className={`rounded-xl px-3 py-1.5 text-xs font-medium transition ${
                  headerTab === "tools"
                    ? "bg-white text-[#1f5f95] shadow-[0_10px_24px_rgba(34,90,141,0.15)]"
                    : "text-[#567499] hover:bg-white/70"
                }`}
              >
                Connected Tools
              </button>
            </div>

            {headerTab === "agent" ? (
              <div className="px-3 py-3 text-xs text-[#456689]">
                See 
                Planner &rarr; Pathway Mapper &rarr; Bridge Hunter &rarr; Translational Scout &rarr; Literature Scout &rarr; Final
                Synthesis
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 px-3 py-3 text-[11px]">
                {["OpenTargets", "Reactome", "ChEMBL", "STRING", "BioMCP", "PubMed"].map((toolName) => (
                  <span
                    key={toolName}
                    className="rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1 text-[#48698f]"
                  >
                    {toolName}
                  </span>
                ))}
              </div>
            )}
          </div>
        </header>

        <section className="tg-panel-rise rounded-3xl border border-[#d8e5f3] bg-white/92 p-5 shadow-[0_26px_100px_rgba(18,52,88,0.12)] backdrop-blur md:p-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[#53769a]">Question</div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#6784b2]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void runWithQuery(query);
                }
              }}
              placeholder="e.g., How might obesity lead to type 2 diabetes through inflammatory signaling?"
              className="h-12 w-full rounded-xl border border-[#d7e6f3] bg-[#f8fbff] pl-9 pr-3 text-sm text-[#22385c] outline-none ring-[#2f7ab3] placeholder:text-[#738bab] focus:ring-2"
            />
          </div>
          {apiKeyError ? (
            <div className="mt-2 text-[11px] text-[#c03b52]">{apiKeyError}</div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {SAMPLE_QUERIES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setQuery(item)}
                className="rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1 text-[11px] text-[#4f698f] hover:bg-[#f2f8ff]"
              >
                {item}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#5c7599]">
              Long runs can take a few minutes when multiple branches and literature queries are explored.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 border-[#b7cae3] bg-white text-[#2e5f8a] hover:bg-[#eef6ff]"
                onClick={() => {
                  void runWithQuery(EXAMPLE_QUERY, { allowEmptyKey: true });
                }}
                disabled={isPersistingKey}
              >
                Run example
              </Button>
              <Button
                className="h-11 bg-[#23679b] text-white hover:bg-[#1c547f]"
                onClick={() => {
                  void runWithQuery(query);
                }}
                disabled={!canRun || isPersistingKey}
              >
              Run analysis <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>

        <footer className="border-t border-[#d8e5f3] pt-4 text-[11px] text-[#5f7598]">
          Preclinical evidence synthesis only; not for clinical decision-making.
        </footer>
      </div>
    </main>
  );
}
