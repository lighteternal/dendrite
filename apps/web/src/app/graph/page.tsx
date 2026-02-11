import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function GraphPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const diseaseRaw = params.disease;
  const disease = Array.isArray(diseaseRaw) ? diseaseRaw[0] : diseaseRaw;
  const diseaseIdRaw = Array.isArray(params.diseaseId) ? params.diseaseId[0] : params.diseaseId;
  const diseaseId = diseaseIdRaw?.trim();
  const maxTargetsRaw = Array.isArray(params.maxTargets) ? params.maxTargets[0] : params.maxTargets;
  const maxTargets = Number(maxTargetsRaw ?? 10);

  if (!disease?.trim()) {
    redirect("/");
  }

  const mode =
    maxTargets <= 6 ? "fast" : maxTargets >= 14 ? "deep" : "balanced";

  const target = new URLSearchParams({
    query: disease,
    mode,
  });
  if (diseaseId) {
    target.set("diseaseId", diseaseId);
  }

  redirect(`/brief?${target.toString()}`);
}
