export type ExampleReplayOption = {
  id: string;
  query: string;
};

export const EXAMPLE_REPLAY_OPTIONS: ExampleReplayOption[] = [
  {
    id: "example-dss-barrier-v2",
    query: "DSS colitis with low TEER/CLDN1/OCLN: upstream mediators + approved drugs?",
  },
  {
    id: "example-nash-lipotoxicity-v2",
    query:
      "Diet-induced NASH with hepatocyte ballooning and ALT/AST: lipid-overload mediators and approved drugs?",
  },
];

export const EXAMPLE_REPLAY_ID = EXAMPLE_REPLAY_OPTIONS[0].id;
export const EXAMPLE_REPLAY_QUERY = EXAMPLE_REPLAY_OPTIONS[0].query;
