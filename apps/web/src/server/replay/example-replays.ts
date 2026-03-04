import { EXAMPLE_REPLAY_OPTIONS } from "@/lib/example-replay";

export type ReplayEvent = {
  event: string;
  data: unknown;
};

export type ReplayFixture = {
  id: string;
  query: string;
  durationMs: number;
  evidenceReview: {
    checkedAt: string;
    reviewer: string;
    rationale: string;
    sources: string[];
  };
  eventsPath: string;
};

const replayMetaById: Record<
  string,
  {
    durationMs: number;
    evidenceReview: ReplayFixture["evidenceReview"];
  }
> = {
  "example-dss-barrier-v2": {
    durationMs: 95_000,
    evidenceReview: {
      checkedAt: "2026-03-03",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay captured from a full completed run centered on DSS barrier dysfunction with explicit TEER/CLDN1/OCLN anchoring, mediator ranking, and approved-drug prioritization.",
      sources: [
        "https://reactome.org/PathwayBrowser/",
        "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10232586/",
        "https://www.nature.com/articles/s41575-022-00657-7",
      ],
    },
  },
  "example-nash-lipotoxicity-v2": {
    durationMs: 95_000,
    evidenceReview: {
      checkedAt: "2026-03-03",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay captured from a completed run in diet-induced NASH with mechanistic mediator ranking and translational drug prioritization aligned to ballooning and ALT/AST context.",
      sources: [
        "https://reactome.org/PathwayBrowser/",
        "https://www.nature.com/articles/s41575-021-00503-7",
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9242987/",
      ],
    },
  },
};

const fixtures: Record<string, ReplayFixture> = Object.fromEntries(
  EXAMPLE_REPLAY_OPTIONS.map((option) => {
    const meta = replayMetaById[option.id];
    return [
      option.id,
      {
        id: option.id,
        query: option.query,
        durationMs: meta?.durationMs ?? 75_000,
        evidenceReview: meta?.evidenceReview ?? {
          checkedAt: new Date().toISOString().slice(0, 10),
          reviewer: "dendrite-maintainer",
          rationale: "Replay fixture loaded from captured run output.",
          sources: [],
        },
        eventsPath: `/replays/${option.id}.events.json`,
      } satisfies ReplayFixture,
    ];
  }),
);

export function getReplayFixture(id: string | null | undefined): ReplayFixture | null {
  if (!id) return null;
  return fixtures[id] ?? null;
}
