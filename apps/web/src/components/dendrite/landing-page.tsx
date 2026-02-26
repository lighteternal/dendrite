"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  Github,
  KeyRound,
  Linkedin,
  Network,
  PlayCircle,
  Search,
  Sparkles,
} from "lucide-react";
import { LandingMoleculeBackground } from "@/components/dendrite/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EXAMPLE_REPLAY_OPTIONS } from "@/lib/example-replay";

const SAMPLE_QUERIES = EXAMPLE_REPLAY_OPTIONS.map((option) => option.query);
const GITHUB_URL = "https://github.com/lighteternal/dendrite";
const LINKEDIN_URL = "https://www.linkedin.com/in/dimitris-papadopoulos/";

const LIVE_WORDS = ["live.", "as evidence arrives.", "hypothesis-by-hypothesis."] as const;
const AGENT_SEQUENCE = [
  "Query Planner",
  "Pathway Mapper",
  "Translational Scout",
  "Bridge Hunter",
  "Literature Scout",
  "Final Synthesis",
] as const;
const CONNECTED_MCP_TOOLS = [
  { key: "opentargets", label: "OpenTargets MCP" },
  { key: "reactome", label: "Reactome MCP" },
  { key: "string", label: "STRING MCP" },
  { key: "chembl", label: "ChEMBL MCP" },
  { key: "biomcp", label: "BioMCP" },
  { key: "pubmed", label: "PubMed MCP" },
  { key: "medical", label: "Medical MCP" },
] as const;

type ToolHealthState = "loading" | "green" | "yellow" | "red";

type ToolHealthMap = Record<
  (typeof CONNECTED_MCP_TOOLS)[number]["key"],
  {
    state: ToolHealthState;
    detail: string;
    latencyMs: number | null;
  }
>;

function initialToolHealthMap(): ToolHealthMap {
  return Object.fromEntries(
    CONNECTED_MCP_TOOLS.map((tool) => [
      tool.key,
      {
        state: "loading",
        detail: "Health probe pending",
        latencyMs: null,
      },
    ]),
  ) as ToolHealthMap;
}

function MiniGraphPreview() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#d8e5f3] bg-white/85 p-5 shadow-[0_18px_50px_rgba(18,52,88,0.12)]">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#5778a2]">
        Example mechanism graph: T2D → ACE → CKD
      </div>
      <svg viewBox="0 0 360 210" className="h-56 w-full">
        <defs>
          <linearGradient id="tg-line" x1="0" x2="1">
            <stop offset="0%" stopColor="#7aa7ff" />
            <stop offset="100%" stopColor="#3a6bb2" />
          </linearGradient>
          <marker id="tg-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#6c8dbe" />
          </marker>
        </defs>

        <line className="tg-micro-dash tg-edge-pulse" x1="60" y1="120" x2="120" y2="70" stroke="url(#tg-line)" strokeWidth="2" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-pulse" x1="120" y1="70" x2="175" y2="120" stroke="url(#tg-line)" strokeWidth="2" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-pulse" x1="175" y1="120" x2="215" y2="70" stroke="url(#tg-line)" strokeWidth="2" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-pulse" x1="215" y1="70" x2="260" y2="110" stroke="url(#tg-line)" strokeWidth="2" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-pulse" x1="260" y1="110" x2="300" y2="70" stroke="url(#tg-line)" strokeWidth="1.8" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-pulse" x1="300" y1="70" x2="320" y2="150" stroke="url(#tg-line)" strokeWidth="2" markerEnd="url(#tg-arrow)" />

        <line className="tg-micro-dash tg-edge-soft" x1="90" y1="160" x2="175" y2="120" stroke="url(#tg-line)" strokeWidth="1.4" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-soft" x1="155" y1="180" x2="260" y2="110" stroke="url(#tg-line)" strokeWidth="1.2" markerEnd="url(#tg-arrow)" />
        <line className="tg-micro-dash tg-edge-soft" x1="95" y1="60" x2="215" y2="70" stroke="url(#tg-line)" strokeWidth="1.2" markerEnd="url(#tg-arrow)" />

        <rect x="135" y="110" width="90" height="22" rx="11" fill="#eef4ff" stroke="#c8d9ef" />
        <text x="154" y="125" fontSize="8" fill="#4e6c92" fontWeight="600">RAAS</text>

        <circle cx="60" cy="120" r="12" fill="#4f46e5" opacity="0.92" className="tg-node-float" />
        <circle cx="120" cy="70" r="9" fill="#9aa5ff" opacity="0.9" className="tg-node-burst" style={{ animationDelay: "0.2s" }} />
        <circle cx="215" cy="70" r="16" fill="#e94d89" opacity="0.92" className="tg-node-pop" />
        <circle cx="260" cy="110" r="11" fill="#0f766e" opacity="0.9" className="tg-node-float" style={{ animationDelay: "0.4s" }} />
        <circle cx="300" cy="70" r="8" fill="#5aa3ff" opacity="0.9" className="tg-node-burst" style={{ animationDelay: "0.6s" }} />
        <circle cx="320" cy="150" r="12" fill="#7c3aed" opacity="0.85" className="tg-node-pop" style={{ animationDelay: "0.3s" }} />

        <circle cx="90" cy="160" r="6" fill="#c4b5fd" className="tg-node-burst" style={{ animationDelay: "0.9s" }} />
        <circle cx="155" cy="180" r="6" fill="#7dd3fc" className="tg-node-burst" style={{ animationDelay: "1.1s" }} />
        <circle cx="95" cy="60" r="6" fill="#a5b4fc" className="tg-node-burst" style={{ animationDelay: "1.3s" }} />

        <circle cx="215" cy="70" r="26" fill="none" stroke="#cbdaf0" strokeWidth="1.2" className="tg-ring" />

        <text x="46" y="144" fontSize="8" fill="#2a4a6f" fontWeight="600">T2D</text>
        <text x="103" y="54" fontSize="6.5" fill="#4e6c92">AGT</text>
        <text x="108" y="88" fontSize="6.5" fill="#4e6c92">Hyperglycemia</text>
        <text x="205" y="52" fontSize="8" fill="#2a4a6f" fontWeight="600">ACE</text>
        <text x="248" y="132" fontSize="7" fill="#2a4a6f">Ang II</text>
        <text x="292" y="52" fontSize="6.5" fill="#4e6c92">AGTR1</text>
        <text x="307" y="172" fontSize="8" fill="#2a4a6f" fontWeight="600">CKD</text>
        <text x="80" y="176" fontSize="6" fill="#4e6c92">REN</text>
        <text x="145" y="196" fontSize="6" fill="#4e6c92">ACE2</text>
      </svg>
      <div className="absolute -right-10 -top-12 h-28 w-28 rounded-full bg-[#e5f1ff] opacity-70 blur-3xl" />
      <div className="absolute -bottom-10 -left-12 h-24 w-24 rounded-full bg-[#eef4ff] opacity-70 blur-3xl" />
    </div>
  );
}

export function LandingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [isPersistingKey, setIsPersistingKey] = useState(false);
  const [selectedExampleId, setSelectedExampleId] = useState(
    EXAMPLE_REPLAY_OPTIONS[0]?.id ?? "",
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [headerTab, setHeaderTab] = useState<"agent" | "tools">("agent");
  const [liveWordIndex, setLiveWordIndex] = useState(0);
  const [typedLiveWord, setTypedLiveWord] = useState("");
  const [isDeletingLiveWord, setIsDeletingLiveWord] = useState(false);
  const [activeAgentStep, setActiveAgentStep] = useState(0);
  const [toolHealth, setToolHealth] = useState<ToolHealthMap>(() => initialToolHealthMap());

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

  useEffect(() => {
    let cancelled = false;

    const loadHealth = async (refresh = false) => {
      try {
        const response = await fetch(
          refresh ? "/api/mcpHealth?refresh=1" : "/api/mcpHealth",
          {
            cache: "no-store",
          },
        );
        if (!response.ok) {
          throw new Error(`health request failed (${response.status})`);
        }
        const payload = (await response.json()) as {
          checkedAt?: unknown;
          tools?: Array<{
            key?: unknown;
            state?: unknown;
            detail?: unknown;
            latencyMs?: unknown;
          }>;
        };
        if (cancelled) return;

        const next = initialToolHealthMap();
        for (const row of payload.tools ?? []) {
          const key = String(row.key ?? "") as keyof ToolHealthMap;
          if (!(key in next)) continue;
          const rowState =
            row.state === "green"
              ? "green"
              : row.state === "yellow"
                ? "yellow"
                : "red";
          next[key] = {
            state: rowState,
            detail:
              typeof row.detail === "string" && row.detail.trim().length > 0
                ? row.detail
                : rowState === "green"
                  ? "Probe succeeded"
                  : rowState === "yellow"
                    ? "Service reachable, capability probe degraded"
                    : "Service unreachable",
            latencyMs:
              typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs)
                ? Math.max(0, Math.round(row.latencyMs))
                : null,
          };
        }

        setToolHealth(next);
      } catch {
        if (cancelled) return;
        setToolHealth((current) => {
          const next = { ...current };
          for (const tool of CONNECTED_MCP_TOOLS) {
            const currentState = next[tool.key];
            if (currentState.state === "loading") {
              next[tool.key] = {
                state: "red",
                detail: "Health probe unavailable",
                latencyMs: null,
              };
            }
          }
          return next;
        });
      }
    };

    void loadHealth();
    const interval = window.setInterval(() => {
      void loadHealth(true);
    }, 120_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveAgentStep((current) => (current + 1) % AGENT_SEQUENCE.length);
    }, 1300);
    return () => window.clearInterval(interval);
  }, []);

  const hasApiKey = apiKey.trim().length > 0;
  const canRun = query.trim().length >= 6 && hasApiKey;
  const selectedExample =
    EXAMPLE_REPLAY_OPTIONS.find((option) => option.id === selectedExampleId) ??
    EXAMPLE_REPLAY_OPTIONS[0];

  const resolveSessionId = () => {
    if (typeof window === "undefined") return "landing-session";
    const storageKey = "dendrite_session_id";
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
      replayId?: string | null;
    },
  ) => {
    const trimmedQuery = inputQuery.trim();
    if (trimmedQuery.length < 6) return;
    const allowEmptyKey = options?.allowEmptyKey ?? false;
    const replayId = options?.replayId?.trim() || null;
    if (!allowEmptyKey && !hasApiKey) {
      setApiKeyError("Enter your OpenAI API key to run a custom query.");
      setShowApiKey(true);
      return;
    }
    setApiKeyError(null);
    setIsPersistingKey(true);
    try {
      if (!replayId || hasApiKey) {
        await persistSessionApiKey();
      }
      const nextUrl = replayId
        ? `/brief?query=${encodeURIComponent(trimmedQuery)}&replay=${encodeURIComponent(replayId)}`
        : `/brief?query=${encodeURIComponent(trimmedQuery)}`;
      router.push(nextUrl);
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not start run.");
    } finally {
      setIsPersistingKey(false);
    }
  };

  const runExample = () => {
    if (!selectedExample) return;
    setQuery(selectedExample.query);
    void runWithQuery(selectedExample.query, {
      allowEmptyKey: true,
      replayId: selectedExample.id,
    });
  };

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />
      <div className="pointer-events-none absolute left-0 top-20 z-20">
        <div className="rounded-r-full border border-l-0 border-[#d7e5f3] bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#4f6f95] shadow-[0_10px_24px_rgba(18,52,88,0.12)] backdrop-blur">
          Alpha
        </div>
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pb-12 pt-8 md:px-8 md:pt-12">
        <header className="tg-panel-rise rounded-3xl border border-[#d8e5f3] bg-white/90 p-6 shadow-[0_36px_120px_rgba(18,52,88,0.14)] backdrop-blur md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="rounded-full bg-[#235f8f] px-3 py-1 text-white">Dendrite</Badge>
              <Badge className="rounded-full border border-[#d6e5f3] bg-[#f5faff] text-[#38658e]">
                Agentic biomedical discovery
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#5f7598]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1">
                <Sparkles className="h-3 w-3 text-[#1f5f95]" /> Live evidence graph
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1">
                <Network className="h-3 w-3 text-[#1f5f95]" /> 7 data sources
              </span>
            </div>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
            <div className="space-y-4">
              <h1 className="text-3xl font-semibold leading-tight tracking-tight text-[#17355f] md:text-5xl lg:text-[56px]">
                Trace multi-hop mechanistic hypotheses across diseases, targets, pathways, and interventions.
              </h1>

              <p className="max-w-2xl text-sm leading-7 text-[#4b6b8f] md:text-base">
                Agentic AI explores competing routes, keeps every tested branch visible, and produces an
                evidence-grounded synthesis with citations, caveats, and next experiments. Watch it{" "}
                <span className="inline-flex min-w-[24ch] items-center font-semibold text-[#1e5f95]">
                  {typedLiveWord || " "}
                  <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-[#1e5f95]" />
                </span>
              </p>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-[#d8e5f3] bg-[#f7fbff] p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#1f5f95]">
                    <Sparkles className="h-4 w-4" /> Agentic routing
                  </div>
                  <div className="mt-2 text-[11px] text-[#5f7899]">
                    Competing multihop paths explored in parallel, with rankable evidence threads.
                  </div>
                </div>
                <div className="rounded-2xl border border-[#d8e5f3] bg-[#f7fbff] p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#1f5f95]">
                    <Network className="h-4 w-4" /> Live mechanism graph
                  </div>
                  <div className="mt-2 text-[11px] text-[#5f7899]">
                    Nodes and edges expand as tools respond, preserving the explored branches.
                  </div>
                </div>
                <div className="rounded-2xl border border-[#d8e5f3] bg-[#f7fbff] p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#1f5f95]">
                    <BookOpen className="h-4 w-4" /> Evidence brief
                  </div>
                  <div className="mt-2 text-[11px] text-[#5f7899]">
                    Cited synthesis with next experiments and uncertainty noted for each thread.
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] text-[#567499]">
                {CONNECTED_MCP_TOOLS.map((tool) => (
                  <span
                    key={tool.key}
                    className="rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1"
                  >
                    {tool.label.replace(" MCP", "")}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <MiniGraphPreview />
            </div>
          </div>

          <section className="mt-8 rounded-3xl border border-[#d8e5f3] bg-white/95 p-8 shadow-[0_26px_80px_rgba(18,52,88,0.12)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#53769a]">
                Start a live query
              </div>
              <Badge className="rounded-full border border-[#d6e5f3] bg-[#f5faff] text-[11px] text-[#38658e]">
                OpenAI API key required
              </Badge>
            </div>

            <div className="mt-4 grid gap-5">
              <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-4 top-5 h-5 w-5 text-[#6784b2]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void runWithQuery(query);
                      }
                    }}
                    placeholder="e.g., How might obesity lead to type 2 diabetes through inflammatory signaling?"
                    className="h-[68px] w-full rounded-3xl border border-[#d7e6f3] bg-[#f8fbff] pl-12 pr-4 text-[18px] text-[#22385c] outline-none ring-[#2f7ab3] placeholder:text-[#738bab] focus:ring-2"
                  />
                </div>
                <Button
                  className="h-12 bg-[#23679b] text-white hover:bg-[#1c547f]"
                  onClick={() => {
                    void runWithQuery(query);
                  }}
                  disabled={!canRun || isPersistingKey}
                >
                  Run live analysis <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
              {apiKeyError ? <div className="text-[11px] text-[#c03b52]">{apiKeyError}</div> : null}
              <div className="text-[11px] text-[#5c7599]">
                Long runs can take 5-12 minutes. The graph stays live while synthesis finishes.
              </div>

              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-xl border border-[#d7e5f3] bg-white px-3 py-3">
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
                    className="h-10 w-full rounded-lg border border-[#d7e5f3] bg-white px-3 text-sm text-[#244062] outline-none ring-[#2f7ab3] placeholder:text-[#8094b4] focus:ring-2"
                  />
                  <div className="mt-1 text-[11px] text-[#5e7698]">
                    Required for live analysis. Your key stays in your session only.
                  </div>
                </div>

                <div className="rounded-xl border border-[#dbe8f5] bg-[#f7fbff] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6a86a8]">
                    Suggested prompts
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
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
                </div>
              </div>

            </div>
          </section>

          <section className="mt-4 rounded-2xl border border-[#d8e5f3] bg-white/90 p-5 shadow-[0_22px_70px_rgba(18,52,88,0.12)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#6a86a8]">
                Example replays
              </div>
              <Badge className="rounded-full border border-[#d6e5f3] bg-[#f5faff] text-[11px] text-[#38658e]">
                Cached traces
              </Badge>
            </div>
            <div className="mt-2 text-[11px] text-[#5c7599]">
              Runs against stored traces for quick demos while live analysis uses your API key.
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-[1.4fr_0.6fr]">
              <Select
                value={selectedExampleId}
                disabled={isPersistingKey}
                onValueChange={(value) => setSelectedExampleId(value)}
              >
                <SelectTrigger className="h-11 w-full border-[#b7cae3] bg-white text-[#2e5f8a] hover:bg-[#eef6ff]">
                  <SelectValue placeholder="Choose an example replay" />
                </SelectTrigger>
                <SelectContent className="border-[#d0e0f1] bg-white text-[#2e5f8a]">
                  {EXAMPLE_REPLAY_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id} className="text-xs">
                      {option.query}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="h-11 border border-[#d6e5f3] bg-[#f5faff] text-[#275d8f] hover:bg-[#e8f2ff]"
                onClick={runExample}
                disabled={!selectedExample || isPersistingKey}
              >
                <PlayCircle className="mr-2 h-4 w-4" /> Run example replay
              </Button>
            </div>
          </section>

          <div className="mt-6 rounded-2xl border border-[#d8e5f3] bg-[#f7fbff]">
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
                <span className="mr-1 text-[#55759a]">Agent loop:</span>
                <span className="inline-flex flex-wrap items-center gap-1 align-middle">
                  {AGENT_SEQUENCE.map((step, index) => {
                    const isActive = index === activeAgentStep;
                    return (
                      <span key={step} className="inline-flex items-center gap-1">
                        <span
                          className={`rounded-md border px-1.5 py-0.5 transition ${
                            isActive
                              ? "border-[#9ec5e9] bg-white text-[#1f5f95] shadow-[0_6px_14px_rgba(34,90,141,0.12)]"
                              : "border-transparent bg-[#f2f8ff] text-[#6583a8]"
                          }`}
                        >
                          {step}
                        </span>
                        {index < AGENT_SEQUENCE.length - 1 ? (
                          <span className={`transition ${isActive ? "text-[#4f7fad]" : "text-[#8aa4bf]"}`}>
                            •
                          </span>
                        ) : null}
                      </span>
                    );
                  })}
                </span>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 px-3 py-3 text-[11px]">
                  {CONNECTED_MCP_TOOLS.map((tool) => {
                    const health = toolHealth[tool.key];
                    const dotClass =
                      health.state === "green"
                        ? "bg-emerald-500"
                        : health.state === "yellow"
                          ? "bg-amber-500"
                          : health.state === "red"
                            ? "bg-rose-500"
                            : "bg-slate-300";
                    const title =
                      health.latencyMs !== null
                        ? `${health.detail} (${health.latencyMs}ms)`
                        : health.detail;
                    return (
                      <span
                        key={tool.key}
                        title={title}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#d6e5f3] bg-white px-2.5 py-1 text-[#48698f]"
                      >
                        <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                        {tool.label}
                      </span>
                    );
                  })}
                </div>
                <div className="px-3 pb-3 text-[10px] text-[#5e7698]">Status reflects live connectivity.</div>
              </>
            )}
          </div>
        </header>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#d8e5f3] pt-4 text-[11px] text-[#5f7598]">
          <span>Preclinical evidence synthesis only; not for clinical decision-making.</span>
          <div className="flex items-center gap-2">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Dendrite on GitHub"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#f2c79b] bg-white/85 text-[#cc6f22] transition-colors hover:text-[#a65217] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e79a58]"
              title="GitHub"
            >
              <Github className="h-[18px] w-[18px]" />
            </a>
            <a
              href={LINKEDIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Dimitris Papadopoulos on LinkedIn"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#f2c79b] bg-white/85 text-[#cc6f22] transition-colors hover:text-[#a65217] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e79a58]"
              title="LinkedIn"
            >
              <Linkedin className="h-[18px] w-[18px]" />
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
