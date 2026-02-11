import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createPatchToolCallsMiddleware, createSubAgentMiddleware, type SubAgent } from "deepagents";
import { z } from "zod";
import { getLiteratureAndTrials } from "@/server/mcp/biomcp";
import { getTargetActivityDrugs } from "@/server/mcp/chembl";
import {
  getDiseaseTargetsSummary,
  getKnownDrugsForTarget,
  searchDiseases,
} from "@/server/mcp/opentargets";
import { findPathwaysByGene } from "@/server/mcp/reactome";
import { getInteractionNetwork } from "@/server/mcp/stringdb";
import { appConfig } from "@/server/config";

export type DiscoverEntity = {
  type: "disease" | "target" | "pathway" | "drug" | "interaction";
  label: string;
  primaryId?: string;
};

export type DiscoverJourneyEntry = {
  id: string;
  ts: string;
  kind: "phase" | "tool_start" | "tool_result" | "insight" | "warning";
  title: string;
  detail: string;
  source: "agent" | "opentargets" | "reactome" | "chembl" | "string" | "biomcp";
  entities: DiscoverEntity[];
};

export type DiscovererFinal = {
  answer: string;
  biomedicalCase: {
    title: string;
    whyAgentic: string;
  };
  focusThread: {
    pathway: string;
    target: string;
    drug: string;
  };
  keyFindings: string[];
  caveats: string[];
  nextActions: string[];
};

type RunParams = {
  diseaseQuery: string;
  diseaseIdHint?: string;
  question: string;
  emitJourney: (entry: DiscoverJourneyEntry) => void;
};

type DiseaseInfo = {
  id: string;
  name: string;
  description?: string;
};

type TargetInfo = {
  id: string;
  symbol: string;
  name: string;
  score: number;
};

type PathwayInfo = {
  id: string;
  name: string;
};

type DrugInfo = {
  id: string;
  name: string;
  source: "opentargets" | "chembl";
};

type LitTrialInfo = {
  articles: number;
  trials: number;
};

type DiscoveryState = {
  disease: DiseaseInfo | null;
  targets: TargetInfo[];
  pathwaysByTarget: Map<string, PathwayInfo[]>;
  drugsByTarget: Map<string, DrugInfo[]>;
  litTrialByTarget: Map<string, LitTrialInfo>;
  interactionNodes: string[];
};

const diseaseEntityPattern = /^(EFO|MONDO|ORPHANET|DOID|HP)[_:]/i;

const agentResponseSchema = z.object({
  directAnswer: z.string(),
  mechanismSummary: z.array(z.string()),
  caveats: z.array(z.string()),
  nextActions: z.array(z.string()),
});

const resolveDiseaseSchema = z.object({
  query: z.string(),
});

const topTargetsSchema = z.object({
  diseaseId: z.string(),
  limit: z.number().int().min(3).max(20),
});

const pathwaysSchema = z.object({
  symbolsCsv: z.string(),
  perTarget: z.number().int().min(1).max(10),
});

const drugsSchema = z.object({
  symbolsCsv: z.string(),
  perTarget: z.number().int().min(1).max(10),
});

const interactionsSchema = z.object({
  symbolsCsv: z.string(),
  confidence: z.number().min(0.1).max(1),
  maxNeighbors: z.number().int().min(5).max(80),
});

const literatureSchema = z.object({
  symbolsCsv: z.string(),
  perTarget: z.number().int().min(1).max(6),
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function inferBiomedicalCase(diseaseName: string | undefined): {
  title: string;
  whyAgentic: string;
} {
  const label = (diseaseName ?? "").toLowerCase();

  if (label.includes("rheumatoid")) {
    return {
      title: "TNF-inhibitor refractory rheumatoid arthritis (program triage)",
      whyAgentic:
        "This case needs concurrent pathway bottleneck mapping and tractability scouting before selecting one mechanism thread for validation.",
    };
  }

  if (label.includes("non-small cell") || label.includes("nsclc")) {
    return {
      title: "EGFR-driven NSCLC with resistance progression (combination design)",
      whyAgentic:
        "Parallel mechanism and compound scouting is needed to surface resistance-aware target-drug threads with explicit caveats.",
    };
  }

  if (label.includes("alzheimer")) {
    return {
      title: "Early Alzheimer's translational prioritization (mechanism triage)",
      whyAgentic:
        "This workflow requires simultaneous mapping of target evidence, pathway coherence, and intervention tractability before choosing one experimental thread.",
    };
  }

  if (label.includes("acute myeloid") || label.includes("aml")) {
    return {
      title: "Acute myeloid leukemia resistance-aware prioritization",
      whyAgentic:
        "Agentic parallel retrieval helps compare pathway hooks, target centrality, and available compounds before committing wet-lab resources.",
    };
  }

  return {
    title: "Translational mechanism triage",
    whyAgentic:
      "This workflow benefits from parallel evidence retrieval across targets, pathways, compounds, interactions, and literature context.",
  };
}

function parseSymbolsCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((token) => clean(token))
    .filter(Boolean);
}

function toAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const maybe = (part as { text?: unknown }).text;
        return typeof maybe === "string" ? maybe : "";
      }
      return "";
    })
    .join("\n")
    .trim();
}

function toThread(state: DiscoveryState) {
  const topTarget = state.targets[0];
  const pathways = topTarget ? (state.pathwaysByTarget.get(topTarget.symbol) ?? []) : [];
  const drugs = topTarget ? (state.drugsByTarget.get(topTarget.symbol) ?? []) : [];
  const topPathwayRaw = pathways[0]?.name;
  const topPathway = Array.isArray(topPathwayRaw)
    ? topPathwayRaw.map((item) => String(item)).join(", ")
    : typeof topPathwayRaw === "string"
      ? topPathwayRaw
      : "not provided";

  return {
    target: topTarget?.symbol ?? "not provided",
    pathway: topPathway,
    drug: drugs[0]?.name ?? "not provided",
  };
}

function buildFallbackSummary(state: DiscoveryState): DiscovererFinal {
  const thread = toThread(state);
  const disease = state.disease?.name ?? "selected disease";
  const biomedicalCase = inferBiomedicalCase(state.disease?.name);

  const caveats: string[] = [];
  if (thread.target === "not provided") caveats.push("Target evidence not available.");
  if (thread.pathway === "not provided") caveats.push("Pathway mapping not available.");
  if (thread.drug === "not provided") caveats.push("Drugability mapping not available.");
  if (state.interactionNodes.length === 0) caveats.push("Interaction neighborhood not available.");

  return {
    answer: `For ${disease}, the current best-supported exploratory thread is ${thread.pathway} -> ${thread.target} -> ${thread.drug}.`,
    biomedicalCase,
    focusThread: thread,
    keyFindings: [
      `Mapped ${state.targets.length} high-evidence targets.`,
      `Mapped ${
        [...state.pathwaysByTarget.values()].reduce((acc, arr) => acc + arr.length, 0)
      } target-pathway links.`,
      `Mapped ${[...state.drugsByTarget.values()].reduce((acc, arr) => acc + arr.length, 0)} target-drug links.`,
      `Captured ${state.interactionNodes.length} interaction neighbors.`,
    ],
    caveats: caveats.length > 0 ? caveats : ["No major missing inputs flagged."],
    nextActions: [
      "Use Predominant-connection lens = Pathway-mechanism.",
      "Raise network density until pathway branching is visible.",
      "Run Hypothesis Mode on the selected pathway and compare top-3 targets.",
    ],
  };
}

export async function runDeepDiscoverer({
  diseaseQuery,
  diseaseIdHint,
  question,
  emitJourney,
}: RunParams): Promise<DiscovererFinal> {
  const state: DiscoveryState = {
    disease: null,
    targets: [],
    pathwaysByTarget: new Map<string, PathwayInfo[]>(),
    drugsByTarget: new Map<string, DrugInfo[]>(),
    litTrialByTarget: new Map<string, LitTrialInfo>(),
    interactionNodes: [],
  };

  let entryCounter = 0;
  const push = (
    kind: DiscoverJourneyEntry["kind"],
    title: string,
    detail: string,
    source: DiscoverJourneyEntry["source"],
    entities: DiscoverEntity[] = [],
  ) => {
    entryCounter += 1;
    emitJourney({
      id: `discover-${entryCounter}`,
      ts: new Date().toISOString(),
      kind,
      title,
      detail,
      source,
      entities,
    });
  };

  const resolveDisease = async (queryRaw: string) => {
    const query = clean(queryRaw) || diseaseQuery;
    const matches = await searchDiseases(query, 10);
    const diseaseMatches = matches.filter((item) => diseaseEntityPattern.test(item.id));
    const pool = diseaseMatches.length > 0 ? diseaseMatches : matches;
    const selected =
      pool.find((item) => item.id === diseaseIdHint) ??
      pool.find((item) => item.name.toLowerCase() === query.toLowerCase()) ??
      pool[0];

    const resolved: DiseaseInfo = {
      id: selected?.id ?? `QUERY_${query.replace(/\s+/g, "_")}`,
      name: selected?.name ?? query,
      description: selected?.description,
    };

    state.disease = resolved;
    return resolved;
  };

  const resolveDiseaseTool = tool(
    async ({ query }) => {
      push("tool_start", "Resolve disease", `Resolving disease entity for "${query}".`, "opentargets");
      const resolved = await resolveDisease(query);
      push(
        "tool_result",
        "Disease resolved",
        `${resolved.name} (${resolved.id})`,
        "opentargets",
        [{ type: "disease", label: resolved.name, primaryId: resolved.id }],
      );
      return JSON.stringify(resolved);
    },
    {
      name: "resolve_disease",
      description:
        "Resolve a disease query into a disease ontology entity (EFO/MONDO/ORPHANET/DOID/HP).",
      schema: resolveDiseaseSchema,
    },
  );

  const topTargetsTool = tool(
    async ({ diseaseId, limit }) => {
      const activeDisease =
        state.disease ?? (await resolveDisease(diseaseId || diseaseQuery));
      const resolvedDiseaseId = clean(diseaseId) || activeDisease.id;
      const size = clamp(limit, 3, 20);
      push(
        "tool_start",
        "Fetch top targets",
        `Fetching ${size} disease-associated targets for ${activeDisease.name}.`,
        "opentargets",
        [{ type: "disease", label: activeDisease.name, primaryId: resolvedDiseaseId }],
      );

      const rows = await getDiseaseTargetsSummary(resolvedDiseaseId, size);
      state.targets = rows.slice(0, size).map((row) => ({
        id: row.targetId,
        symbol: row.targetSymbol,
        name: row.targetName,
        score: row.associationScore,
      }));

      const entities = state.targets.slice(0, 6).map((target) => ({
        type: "target" as const,
        label: target.symbol,
        primaryId: target.id,
      }));

      push(
        "tool_result",
        "Targets mapped",
        `${state.targets.length} targets loaded (top: ${state.targets
          .slice(0, 3)
          .map((target) => target.symbol)
          .join(", ")}).`,
        "opentargets",
        entities,
      );

      return JSON.stringify({
        disease: activeDisease,
        targets: state.targets,
      });
    },
    {
      name: "get_top_targets",
      description:
        "Fetch top disease-associated targets with Open Targets evidence scores for a disease ID.",
      schema: topTargetsSchema,
    },
  );

  const pathwaysTool = tool(
    async ({ symbolsCsv, perTarget }) => {
      const symbols =
        parseSymbolsCsv(symbolsCsv).length > 0
          ? parseSymbolsCsv(symbolsCsv)
          : state.targets.slice(0, 6).map((target) => target.symbol);

      const cappedPerTarget = clamp(perTarget, 1, 10);
      push(
        "tool_start",
        "Map pathways",
        `Fetching Reactome pathways for ${symbols.length} targets.`,
        "reactome",
        symbols.slice(0, 5).map((symbol) => ({ type: "target", label: symbol })),
      );

      const mapped = await Promise.all(
        symbols.map(async (symbol) => ({
          symbol,
          pathways: (await findPathwaysByGene(symbol)).slice(0, cappedPerTarget),
        })),
      );

      const uniquePathways = new Map<string, PathwayInfo>();
      for (const item of mapped) {
        const pathways = item.pathways.map((pathway) => ({
          id: pathway.id,
          name: Array.isArray(pathway.name)
            ? pathway.name.map((entry) => String(entry)).join(", ")
            : String(pathway.name),
        }));
        state.pathwaysByTarget.set(item.symbol, pathways);
        for (const pathway of pathways) {
          uniquePathways.set(pathway.id, pathway);
        }
      }

      push(
        "tool_result",
        "Pathways mapped",
        `${uniquePathways.size} pathways linked across ${symbols.length} targets.`,
        "reactome",
        [...uniquePathways.values()].slice(0, 6).map((pathway) => ({
          type: "pathway",
          label: pathway.name,
          primaryId: pathway.id,
        })),
      );

      return JSON.stringify({
        targets: symbols,
        pathwaysByTarget: Object.fromEntries(
          [...state.pathwaysByTarget.entries()].map(([symbol, pathways]) => [symbol, pathways]),
        ),
      });
    },
    {
      name: "get_pathways_for_targets",
      description:
        "Fetch Reactome pathways for target symbols and return pathway associations per target.",
      schema: pathwaysSchema,
    },
  );

  const drugsTool = tool(
    async ({ symbolsCsv, perTarget }) => {
      const symbols =
        parseSymbolsCsv(symbolsCsv).length > 0
          ? parseSymbolsCsv(symbolsCsv)
          : state.targets.slice(0, 6).map((target) => target.symbol);
      const cappedPerTarget = clamp(perTarget, 1, 10);

      push(
        "tool_start",
        "Map drugability",
        `Fetching OpenTargets + ChEMBL compounds for ${symbols.length} targets.`,
        "chembl",
        symbols.slice(0, 5).map((symbol) => ({ type: "target", label: symbol })),
      );

      await Promise.all(
        symbols.map(async (symbol) => {
          const target = state.targets.find((item) => item.symbol === symbol);
          const [known, activity] = await Promise.allSettled([
            target
              ? getKnownDrugsForTarget(target.id, cappedPerTarget)
              : Promise.resolve([]),
            getTargetActivityDrugs(symbol, cappedPerTarget),
          ]);

          const options = new Map<string, DrugInfo>();
          if (known.status === "fulfilled") {
            for (const drug of known.value) {
              options.set(drug.drugId, {
                id: drug.drugId,
                name: drug.name,
                source: "opentargets",
              });
            }
          }
          if (activity.status === "fulfilled") {
            for (const drug of activity.value) {
              options.set(drug.moleculeId, {
                id: drug.moleculeId,
                name: drug.name,
                source: "chembl",
              });
            }
          }
          state.drugsByTarget.set(symbol, [...options.values()].slice(0, cappedPerTarget));
        }),
      );

      const unique = new Map<string, DrugInfo>();
      for (const list of state.drugsByTarget.values()) {
        for (const drug of list) unique.set(drug.id, drug);
      }

      push(
        "tool_result",
        "Drugability mapped",
        `${unique.size} compounds linked across ${symbols.length} targets.`,
        "chembl",
        [...unique.values()].slice(0, 8).map((drug) => ({
          type: "drug",
          label: drug.name,
          primaryId: drug.id,
        })),
      );

      return JSON.stringify({
        drugsByTarget: Object.fromEntries(
          [...state.drugsByTarget.entries()].map(([symbol, drugs]) => [symbol, drugs]),
        ),
      });
    },
    {
      name: "get_drugs_for_targets",
      description:
        "Fetch compounds associated with target symbols using OpenTargets known drugs and ChEMBL activities.",
      schema: drugsSchema,
    },
  );

  const interactionsTool = tool(
    async ({ symbolsCsv, confidence, maxNeighbors }) => {
      const symbols =
        parseSymbolsCsv(symbolsCsv).length > 0
          ? parseSymbolsCsv(symbolsCsv)
          : state.targets.slice(0, 8).map((target) => target.symbol);
      const conf = clamp(confidence, 0.1, 1);
      const neighbors = clamp(maxNeighbors, 5, 80);

      push(
        "tool_start",
        "Map interaction neighborhood",
        `Fetching STRING neighborhood (confidence ${conf.toFixed(2)}).`,
        "string",
        symbols.slice(0, 6).map((symbol) => ({ type: "target", label: symbol })),
      );

      const interaction = await getInteractionNetwork(symbols, conf, neighbors);
      state.interactionNodes = interaction.nodes.map((node) => node.symbol);

      push(
        "tool_result",
        "Interaction network mapped",
        `${interaction.nodes.length} nodes and ${interaction.edges.length} interaction edges.`,
        "string",
        interaction.nodes.slice(0, 8).map((node) => ({
          type: "interaction",
          label: node.symbol,
          primaryId: node.id,
        })),
      );

      return JSON.stringify({
        interactionNodes: interaction.nodes,
        interactionEdges: interaction.edges,
      });
    },
    {
      name: "get_interaction_neighborhood",
      description:
        "Fetch STRING interaction neighborhood for target symbols with configurable confidence and neighborhood size.",
      schema: interactionsSchema,
    },
  );

  const literatureTool = tool(
    async ({ symbolsCsv, perTarget }) => {
      const symbols =
        parseSymbolsCsv(symbolsCsv).length > 0
          ? parseSymbolsCsv(symbolsCsv)
          : state.targets.slice(0, 4).map((target) => target.symbol);
      const capped = clamp(perTarget, 1, 6);
      const diseaseName = state.disease?.name ?? diseaseQuery;

      push(
        "tool_start",
        "Collect literature/trials",
        `Fetching BioMCP snippets for ${symbols.length} targets.`,
        "biomcp",
        symbols.slice(0, 4).map((symbol) => ({ type: "target", label: symbol })),
      );

      await Promise.all(
        symbols.slice(0, capped).map(async (symbol) => {
          const firstDrug = state.drugsByTarget.get(symbol)?.[0]?.name;
          const enrichment = await getLiteratureAndTrials(diseaseName, symbol, firstDrug);
          state.litTrialByTarget.set(symbol, {
            articles: enrichment.articles.length,
            trials: enrichment.trials.length,
          });
        }),
      );

      const articleTotal = [...state.litTrialByTarget.values()].reduce(
        (acc, row) => acc + row.articles,
        0,
      );
      const trialTotal = [...state.litTrialByTarget.values()].reduce(
        (acc, row) => acc + row.trials,
        0,
      );

      push(
        "tool_result",
        "Literature/trials collected",
        `${articleTotal} article snippets and ${trialTotal} trial snippets captured.`,
        "biomcp",
      );

      return JSON.stringify({
        literatureByTarget: Object.fromEntries(state.litTrialByTarget.entries()),
      });
    },
    {
      name: "get_literature_trials_for_targets",
      description:
        "Fetch article and trial snippet counts for a short target list in the disease context.",
      schema: literatureSchema,
    },
  );

  const tools = [
    resolveDiseaseTool,
    topTargetsTool,
    pathwaysTool,
    drugsTool,
    interactionsTool,
    literatureTool,
  ];

  const model = new ChatOpenAI({
    model: appConfig.openai.model,
    temperature: 0,
    apiKey: appConfig.openAiApiKey,
  });

  const subagents: SubAgent[] = [
    {
      name: "pathway_mapper",
      description:
        "Maps disease -> target -> pathway -> interaction structure and identifies mechanistic bottlenecks.",
      systemPrompt: [
        "You are a pathway cartographer for translational biology programs.",
        "Use resolve_disease, get_top_targets, get_pathways_for_targets, and get_interaction_neighborhood.",
        "Return mechanistic storylines and explicit data gaps.",
      ].join(" "),
      tools,
      model,
    },
    {
      name: "translational_scout",
      description:
        "Maps target -> compound -> evidence layers and proposes tractable intervention threads.",
      systemPrompt: [
        "You are a translational scout.",
        "Use resolve_disease, get_top_targets, get_drugs_for_targets, and get_literature_trials_for_targets.",
        "Prioritize tractable intervention threads and caveats.",
      ].join(" "),
      tools,
      model,
    },
  ];

  const agent = createAgent({
    model,
    tools,
    middleware: [
      createSubAgentMiddleware({
        defaultModel: model,
        defaultTools: tools,
        subagents,
      }),
      createPatchToolCallsMiddleware(),
    ],
    responseFormat: agentResponseSchema,
    systemPrompt: [
      "You are TargetGraph Discoverer, an agentic biomedical workflow assistant.",
      "MUST use task tool to delegate in parallel to: pathway_mapper and translational_scout.",
      "Only use tool outputs; do not invent papers, pathways, or compounds.",
      "Produce concise, decision-grade output for a translational biology lead.",
    ].join(" "),
  });

  push(
    "phase",
    "Agentic workflow started",
    "Launching parallel pathway mapping and translational scouting using DeepAgents task delegation.",
    "agent",
  );

  if (!appConfig.openAiApiKey) {
    push(
      "warning",
      "OpenAI key missing",
      "Using deterministic fallback summary without LLM synthesis.",
      "agent",
    );

    await resolveDisease(diseaseQuery);
    const diseaseId = state.disease?.id ?? "";
    if (diseaseId) {
      state.targets = (await getDiseaseTargetsSummary(diseaseId, 8)).map((target) => ({
        id: target.targetId,
        symbol: target.targetSymbol,
        name: target.targetName,
        score: target.associationScore,
      }));
    }

    return buildFallbackSummary(state);
  }

  try {
    const response = await agent.invoke({
      messages: [
        {
          role: "user",
          content: [
            `Disease query: ${diseaseQuery}`,
            `Preferred disease ID (if provided): ${diseaseIdHint ?? "not provided"}`,
            `Question: ${question}`,
            "",
            "Return a mechanistic and actionable synthesis with caveats and next actions.",
          ].join("\n"),
        },
      ],
    });

    const structured = response.structuredResponse;
    const thread = toThread(state);
    const keyFindings = [
      `Top target set size: ${state.targets.length}`,
      `Pathway links: ${[...state.pathwaysByTarget.values()].reduce((acc, arr) => acc + arr.length, 0)}`,
      `Drug links: ${[...state.drugsByTarget.values()].reduce((acc, arr) => acc + arr.length, 0)}`,
      `Interaction neighbors: ${state.interactionNodes.length}`,
    ];

    return {
      answer:
        structured && typeof structured.directAnswer === "string"
          ? structured.directAnswer
          : toAssistantText(response.messages[response.messages.length - 1]?.content) ||
            buildFallbackSummary(state).answer,
      biomedicalCase: inferBiomedicalCase(state.disease?.name),
      focusThread: thread,
      keyFindings,
      caveats:
        structured && Array.isArray(structured.caveats) && structured.caveats.length > 0
          ? structured.caveats
          : buildFallbackSummary(state).caveats,
      nextActions:
        structured && Array.isArray(structured.nextActions) && structured.nextActions.length > 0
          ? structured.nextActions
          : buildFallbackSummary(state).nextActions,
    };
  } catch {
    push(
      "warning",
      "Agent synthesis degraded",
      "Falling back to deterministic summary from gathered MCP evidence.",
      "agent",
    );
    return buildFallbackSummary(state);
  }
}
