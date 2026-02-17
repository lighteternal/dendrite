import rawAlsOxidativeEvents from "@/server/replay/fixtures/als-oxidative-v1.events.json";
import { EXAMPLE_REPLAY_ID, EXAMPLE_REPLAY_QUERY } from "@/lib/example-replay";

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

const fixtures: Record<string, ReplayFixture> = {
  [EXAMPLE_REPLAY_ID]: {
    id: EXAMPLE_REPLAY_ID,
    query: EXAMPLE_REPLAY_QUERY,
    durationMs: 60_000,
    evidenceReview: {
      checkedAt: "2026-02-16",
      reviewer: "targetgraph-maintainer",
      rationale:
        "Replay uses a completed ALS/oxidative-stress run whose final synthesis aligns with established mechanisms linking SQSTM1/NFE2L2 antioxidant regulation to oxidative stress in ALS.",
      sources: [
        "https://www.ninds.nih.gov/health-information/disorders/amyotrophic-lateral-sclerosis-als",
        "https://reactome.org/PathwayBrowser/#/R-HSA-3299685",
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC9140622/",
      ],
    },
    events: (rawAlsOxidativeEvents as ReplayEvent[]) ?? [],
  },
};

export function getReplayFixture(id: string | null | undefined): ReplayFixture | null {
  if (!id) return null;
  return fixtures[id] ?? null;
}
