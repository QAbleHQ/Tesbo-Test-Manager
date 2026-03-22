import { redirect } from "next/navigation";

export default function TesboReportsPage({
  params,
}: {
  params: { id: string };
}) {
  redirect(`/projects/${params.id}/tesbo-reports/runs`);
}
