import { Suspense } from "react";
import { InterviewClient } from "./InterviewClient";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading session…</p>}>
      <InterviewClient sid={id} />
    </Suspense>
  );
}
