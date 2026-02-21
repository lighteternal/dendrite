export type ExampleReplayOption = {
  id: string;
  query: string;
};

export const EXAMPLE_REPLAY_OPTIONS: ExampleReplayOption[] = [
  {
    id: "example-obesity-t2d-v1",
    query: "How might obesity lead to type 2 diabetes?",
  },
  {
    id: "example-als-oxidative-v1",
    query: "How is ALS connected to oxidative stress?",
  },
  {
    id: "example-t2d-ckd-v1",
    query: "How is type 2 diabetes connected to chronic kidney disease?",
  },
];

export const EXAMPLE_REPLAY_ID = EXAMPLE_REPLAY_OPTIONS[0].id;
export const EXAMPLE_REPLAY_QUERY = EXAMPLE_REPLAY_OPTIONS[0].query;
