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
  "example-obesity-t2d-v1": {
    durationMs: 75_000,
    evidenceReview: {
      checkedAt: "2026-02-25",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay refreshed from a full completed run linking obesity and type 2 diabetes through adiposity-driven insulin resistance and beta-cell compensation limits with explicit evidence/caveat handling.",
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
      checkedAt: "2026-02-25",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay refreshed from a full completed run describing ALS-oxidative-stress coupling via SOD1-centered antioxidant and proteostasis mechanisms with alternative threads and uncertainty notes.",
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
      checkedAt: "2026-02-25",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay refreshed from a full completed run connecting type 2 diabetes and CKD through ACE/renin-angiotensin and vascular injury mechanisms with intervention-oriented next-step framing.",
      sources: [
        "https://www.kidney.org/kidney-topics/diabetes-and-chronic-kidney-disease",
        "https://www.niddk.nih.gov/health-information/diabetes/overview/preventing-problems/kidney-disease-nephropathy",
        "https://reactome.org/content/detail/R-HSA-202040",
      ],
    },
  },
  "example-cannabis-anorexia-v1": {
    durationMs: 75_000,
    evidenceReview: {
      checkedAt: "2026-02-25",
      reviewer: "dendrite-maintainer",
      rationale:
        "Replay refreshed from a full completed run mapping cannabis-anorexia evidence to dopaminergic and feeding-circuit hypotheses with explicit uncertainty boundaries.",
      sources: [
        "https://www.nature.com/articles/npp2017173",
        "https://www.ncbi.nlm.nih.gov/books/NBK459145/",
        "https://reactome.org/content/detail/R-HSA-418457",
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
