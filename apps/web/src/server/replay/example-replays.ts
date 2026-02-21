import rawObesityT2dEvents from "@/server/replay/fixtures/example-obesity-t2d-v1.events.json";
import rawAlsOxidativeEvents from "@/server/replay/fixtures/example-als-oxidative-v1.events.json";
import rawT2dCkdEvents from "@/server/replay/fixtures/example-t2d-ckd-v1.events.json";
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
  events: ReplayEvent[];
};

const replayEventsById: Record<string, ReplayEvent[]> = {
  "example-obesity-t2d-v1": (rawObesityT2dEvents as ReplayEvent[]) ?? [],
  "example-als-oxidative-v1": (rawAlsOxidativeEvents as ReplayEvent[]) ?? [],
  "example-t2d-ckd-v1": (rawT2dCkdEvents as ReplayEvent[]) ?? [],
};

const replayMetaById: Record<
  string,
  {
    durationMs: number;
    evidenceReview: ReplayFixture["evidenceReview"];
  }
> = {
  "example-obesity-t2d-v1": {
    durationMs: 75_000,
    evidenceReview: {
      checkedAt: "2026-02-20",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay selected from a completed run that resolves obesity to T2D through PPARG/GLP1R-centered metabolic and inflammatory mechanisms with supporting references.",
      sources: [
        "https://www.niddk.nih.gov/health-information/diabetes/overview/what-is-diabetes/type-2-diabetes",
        "https://www.nature.com/articles/nature05482",
        "https://reactome.org/PathwayBrowser/",
      ],
    },
  },
  "example-als-oxidative-v1": {
    durationMs: 75_000,
    evidenceReview: {
      checkedAt: "2026-02-20",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay uses a completed ALS/oxidative-stress run whose final synthesis aligns with established mechanisms linking SQSTM1/NFE2L2 antioxidant regulation to oxidative stress in ALS.",
      sources: [
        "https://www.ninds.nih.gov/health-information/disorders/amyotrophic-lateral-sclerosis-als",
        "https://reactome.org/PathwayBrowser/#/R-HSA-3299685",
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9140622/",
      ],
    },
  },
  "example-t2d-ckd-v1": {
    durationMs: 75_000,
    evidenceReview: {
      checkedAt: "2026-02-21",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay selected from a completed run linking type 2 diabetes mellitus and chronic kidney disease through shared ACE-centered renin-angiotensin and vascular injury mechanisms with literature support.",
      sources: [
        "https://www.kidney.org/kidney-topics/diabetes-and-chronic-kidney-disease",
        "https://www.niddk.nih.gov/health-information/diabetes/overview/preventing-problems/kidney-disease-nephropathy",
        "https://reactome.org/content/detail/R-HSA-202040",
      ],
    },
  },
};

const fixtures: Record<string, ReplayFixture> = Object.fromEntries(
  EXAMPLE_REPLAY_OPTIONS.map((option) => {
    const meta = replayMetaById[option.id];
    const events = replayEventsById[option.id] ?? [];
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
        events,
      } satisfies ReplayFixture,
    ];
  }),
);

export function getReplayFixture(id: string | null | undefined): ReplayFixture | null {
  if (!id) return null;
  return fixtures[id] ?? null;
}
