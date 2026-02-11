import { DecisionBriefWorkspace } from "@/components/targetgraph/decision-brief-workspace";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type RunMode = "fast" | "balanced" | "deep";

export default async function BriefPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const queryRaw = params.query;
  const query = Array.isArray(queryRaw) ? queryRaw[0] : queryRaw;

  if (!query?.trim()) {
    return <div className="p-8 text-sm">Missing query.</div>;
  }

  const modeRaw = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  const mode =
    modeRaw === "fast" || modeRaw === "balanced" || modeRaw === "deep"
      ? (modeRaw as RunMode)
      : ("balanced" as RunMode);

  const diseaseIdRaw = Array.isArray(params.diseaseId) ? params.diseaseId[0] : params.diseaseId;
  const diseaseId = diseaseIdRaw?.trim() || undefined;
  const diseaseNameRaw = Array.isArray(params.diseaseName) ? params.diseaseName[0] : params.diseaseName;
  const diseaseName = diseaseNameRaw?.trim() || undefined;

  return (
    <DecisionBriefWorkspace
      initialQuery={query}
      initialMode={mode}
      initialDiseaseId={diseaseId}
      initialDiseaseName={diseaseName}
    />
  );
}
