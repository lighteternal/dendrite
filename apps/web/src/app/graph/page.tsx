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
      (Array.isArray(params.interactions) ? params.interactions[0] : params.interactions) !== "0",
    literature:
      (Array.isArray(params.literature) ? params.literature[0] : params.literature) !== "0",
  };

  if (!disease) {
    return <div className="p-8 text-sm">Missing disease query.</div>;
  }

  return <GraphWorkbench diseaseQuery={disease} defaults={defaults} />;
}
