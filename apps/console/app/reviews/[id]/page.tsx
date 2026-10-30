export const metadata = { title: "Independent review · Basalt" };
import { ReviewConsole } from "./review-console";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  return <ReviewConsole batchId={(await params).id} />;
}
