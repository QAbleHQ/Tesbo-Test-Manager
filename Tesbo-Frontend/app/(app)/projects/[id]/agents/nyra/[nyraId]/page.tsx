"use client";

import { useParams } from "@/lib/routeParams";
import NyraWorkspace from "@/components/nyra/NyraWorkspace";

export default function NyraProjectPage() {
  const params = useParams();
  return <NyraWorkspace projectId={params.id as string} nyraId={params.nyraId as string} />;
}
