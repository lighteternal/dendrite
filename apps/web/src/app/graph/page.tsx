import { GraphWorkbench } from "@/components/targetgraph/graph-workbench";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function GraphPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const diseaseRaw = params.disease;
  const disease = Array.isArray(diseaseRaw) ? diseaseRaw[0] : diseaseRaw;

  const defaults = {
    pathways: (Array.isArray(params.pathways) ? params.pathways[0] : params.pathways) !== "0",
    drugs: (Array.isArray(params.drugs) ? params.drugs[0] : params.drugs) !== "0",
    interactions:
      (Array.isArray(params.interactions) ? params.interactions[0] : params.interactions) === "1",
    literature:
      (Array.isArray(params.literature) ? params.literature[0] : params.literature) === "1",
  };
  const maxTargetsRaw = Array.isArray(params.maxTargets) ? params.maxTargets[0] : params.maxTargets;
  const parsedMaxTargets = Number(maxTargetsRaw ?? 6);
  const initialMaxTargets = Number.isFinite(parsedMaxTargets)
    ? Math.max(4, Math.min(20, Math.floor(parsedMaxTargets)))
    : 6;
  const diseaseIdRaw = Array.isArray(params.diseaseId) ? params.diseaseId[0] : params.diseaseId;
  const diseaseId = diseaseIdRaw?.trim() || undefined;

  if (!disease) {
    return <div className="p-8 text-sm">Missing disease query.</div>;
  }

  return (
    <GraphWorkbench
      diseaseQuery={disease}
      defaults={defaults}
      initialMaxTargets={initialMaxTargets}
      initialDiseaseId={diseaseId}
    />
  );
}
