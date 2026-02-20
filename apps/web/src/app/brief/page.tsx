import { DecisionBriefWorkspace } from "@/components/dendrite/decision-brief-workspace";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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

  const diseaseIdRaw = Array.isArray(params.diseaseId) ? params.diseaseId[0] : params.diseaseId;
  const diseaseId = diseaseIdRaw?.trim() || undefined;
  const diseaseNameRaw = Array.isArray(params.diseaseName) ? params.diseaseName[0] : params.diseaseName;
  const diseaseName = diseaseNameRaw?.trim() || undefined;
  const replayRaw = Array.isArray(params.replay) ? params.replay[0] : params.replay;
  const replayId = replayRaw?.trim() || undefined;

  return (
    <DecisionBriefWorkspace
      initialQuery={query}
      initialDiseaseId={diseaseId}
      initialDiseaseName={diseaseName}
      initialReplayId={replayId}
    />
  );
}
