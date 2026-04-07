import { redirect } from "next/navigation";

type TestCaseDetailRouteProps = {
  params: {
    id: string;
    tcId: string;
  };
};

export default function TestCaseDetailPage({ params }: TestCaseDetailRouteProps) {
  redirect(`/projects/${params.id}/testcases`);
}
