export const APP_QUESTION =
  "When I type a disease, what are the highest-evidence targets, what pathways connect them, what drugs/compounds already touch them, and what interaction neighborhood suggests mechanistic plausibility—shown as a live, explorable systems graph?";

export const PRESET_DISEASES = [
  "Alzheimer's disease",
  "Non-small cell lung cancer",
  "Rheumatoid arthritis",
  "Crohn disease",
  "Acute myeloid leukemia",
  "Melanoma",
];

export const PIPELINE_STEPS = [
  { id: "P0", label: "Resolve disease" },
  { id: "P1", label: "Fetch target evidence" },
  { id: "P2", label: "Add pathways" },
  { id: "P3", label: "Add drugs/activities" },
  { id: "P4", label: "Add interactions" },
  { id: "P5", label: "Add literature/trials" },
  { id: "P6", label: "Rank and narrative" },
] as const;
