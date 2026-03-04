export type ExampleReplayOption = {
  id: string;
  query: string;
};

export const EXAMPLE_REPLAY_OPTIONS: ExampleReplayOption[] = [
  {
    id: "example-dss-barrier-v2",
    query:
      "In DSS colitis models with reduced epithelial TEER and CLDN1/OCLN downregulation, identify upstream mediators driving barrier dysfunction and prioritize approved drugs targeting those mediators.",
  },
  {
    id: "example-nash-lipotoxicity-v2",
    query:
      "In a diet-induced NASH model showing hepatocyte ballooning and elevated ALT/AST, identify mechanistic mediators linking lipid overload to cell death pathways, and prioritize approved drugs targeting those mediators.",
  },
];

export const EXAMPLE_REPLAY_ID = EXAMPLE_REPLAY_OPTIONS[0].id;
export const EXAMPLE_REPLAY_QUERY = EXAMPLE_REPLAY_OPTIONS[0].query;
