"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Github, Linkedin, Search } from "lucide-react";
import { LandingMoleculeBackground } from "@/components/dendrite/landing-molecule-background";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function LandingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [isPersistingKey, setIsPersistingKey] = useState(false);
  const [exampleSelectResetKey, setExampleSelectResetKey] = useState(0);
  const [headerTab, setHeaderTab] = useState<"agent" | "tools">("agent");
  const [liveWordIndex, setLiveWordIndex] = useState(0);
  const [typedLiveWord, setTypedLiveWord] = useState("");
  const [isDeletingLiveWord, setIsDeletingLiveWord] = useState(false);
  const [activeAgentStep, setActiveAgentStep] = useState(0);
  const [toolHealth, setToolHealth] = useState<ToolHealthMap>(() => initialToolHealthMap());
  const [toolHealthCheckedAt, setToolHealthCheckedAt] = useState<string | null>(null);

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
        setToolHealthCheckedAt(
          typeof payload.checkedAt === "string" ? payload.checkedAt : new Date().toISOString(),
        );
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

  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingMoleculeBackground />
      <div className="pointer-events-none absolute left-0 top-20 z-20">
        <div className="rounded-r-full border border-l-0 border-[#d7e5f3] bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#4f6f95] shadow-[0_10px_24px_rgba(18,52,88,0.12)] backdrop-blur">
          Alpha
        </div>
      </div>

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pb-12 pt-8 md:px-8 md:pt-12">
        <header className="tg-panel-rise rounded-3xl border border-[#d8e5f3] bg-white/90 p-6 shadow-[0_36px_120px_rgba(18,52,88,0.14)] backdrop-blur md:p-8">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="rounded-full bg-[#235f8f] px-3 py-1 text-white">Dendrite</Badge>
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
                You will need an OpenAI API key to run a live query. We never store keys. Use Run example to see
                how it works without a key.
              </div>
            </div>
          </div>

          <h1 className="max-w-4xl text-3xl font-semibold leading-tight tracking-tight text-[#17355f] md:text-5xl">
            Trace multi-hop mechanistic hypotheses across diseases, targets, pathways, and interventions.
          </h1>

          <p className="mt-3 max-w-4xl text-sm leading-7 text-[#4b6b8f] md:text-base">
            Agentic AI explores competing routes, keeps every tested branch visible, and produces an
            evidence-grounded synthesis with citations, caveats, and next experiments. Watch it{" "}
            <span className="inline-flex min-w-[24ch] items-center font-semibold text-[#1e5f95]">
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
                          <span
                            className={`transition ${
                              isActive ? "text-[#4f7fad]" : "text-[#8aa4bf]"
                            }`}
                          >
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
                <div className="px-3 pb-3 text-[10px] text-[#5e7698]">
                  Status reflects live connectivity.
                </div>
              </>
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
              <Select
                key={exampleSelectResetKey}
                disabled={isPersistingKey}
                onValueChange={(value) => {
                  const selected = EXAMPLE_REPLAY_OPTIONS.find((option) => option.id === value);
                  if (!selected) return;
                  setExampleSelectResetKey((current) => current + 1);
                  void runWithQuery(selected.query, {
                    allowEmptyKey: true,
                    replayId: selected.id,
                  });
                }}
              >
                <SelectTrigger className="h-11 w-[340px] border-[#b7cae3] bg-white text-[#2e5f8a] hover:bg-[#eef6ff]">
                  <SelectValue placeholder="Run example" />
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
