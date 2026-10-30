import Link from "next/link";
import { readBenchmarkReceipts, savedRequestSampling } from "../../../../../lib/server";
import { repositoryRoot } from "../../../../../lib/data";
import { notFound } from "next/navigation";
import type { BenchmarkRequestTelemetry } from "../../../../../../../dist/packages/contracts/src/benchmarks.js";
import type { ModelSampling } from "../../../../../../../dist/packages/model-client/src/contracts.js";
import { PageHeading } from "../../../../components/ui";
import { formatMoney } from "../../../../components/api";
import { counted, stageLabel } from "../../../../components/result-display";
import b from "../../../../components/benchmark.module.css";
import s from "../../../../components/workbench.module.css";
export const dynamic = "force-dynamic";

const samplingNames: Record<keyof ModelSampling, string> = {
  temperature: "Temperature",
  top_p: "Top P",
  top_k: "Top K",
  frequency_penalty: "Frequency penalty",
  presence_penalty: "Presence penalty",
  repetition_penalty: "Repetition penalty",
};

/** The sampling values that the request sent. A value that it did not send is a provider default. */
function samplingText(sampling: ModelSampling) {
  const sent = Object.entries(sampling).filter(([, value]) => value !== null);
  if (!sent.length) return "None sent: provider defaults";
  const words = sent
    .map(([name, value]) => `${samplingNames[name as keyof ModelSampling]} ${value}`)
    .join(" · ");
  return sent.length < Object.keys(sampling).length
    ? `${words}. The others use provider defaults.`
    : words;
}

/** How the response ended, with the class of an answer that the output limit cut. */
function endText(row: BenchmarkRequestTelemetry) {
  if (row.cut === "reasoning_exhausted")
    return "Cut by the output limit before the model started its answer";
  if (row.cut === "answer_truncated") return "Cut by the output limit during the answer";
  if (row.resultKind === "provider_error") return "The provider returned an error";
  if (row.resultKind === "invalid_model_response") return "The response wasn’t valid";
  switch (row.stopReason) {
    case "end_turn":
      return "Finished its answer";
    case "tool_calls":
      return "Called a tool";
    case "refusal":
      return "Refused to answer";
    case "other":
      return "Stopped for another reason";
    default:
      return "No saved response";
  }
}

const count = (value: number | null | undefined) =>
  value === null || value === undefined ? "unknown" : value.toLocaleString("en-US");

export default async function RequestDetails({
  params,
}: {
  params: Promise<{ id: string; requestId: string }>;
}) {
  const { id, requestId } = await params;
  if (!/^[a-f0-9]{64}$/.test(requestId)) notFound();
  const receipts = await readBenchmarkReceipts(repositoryRoot(), id),
    row = receipts.requests.find((row) => row.requestId === requestId);
  if (!row) notFound();
  const sampling = await savedRequestSampling(repositoryRoot(), id, row.stage);
  const images = row.imageInputs;
  return (
    <main>
      <PageHeading
        title="Request spending"
        description="This page shows the saved payment and response details for this request."
      />
      <dl className={b.facts}>
        <div>
          <dt>Work</dt>
          <dd>{stageLabel(row.stage.split(":")[0]!)}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>{row.status === "billed" ? "Charged" : "Waiting for the provider's price"}</dd>
        </div>
        <div>
          <dt>Confirmed charge</dt>
          <dd>{row.billedUsd === null ? "Unknown" : formatMoney(row.billedUsd)}</dd>
        </div>
        <div>
          <dt>Pending charge</dt>
          <dd>{row.status === "billed" ? "None" : formatMoney(row.reservedUsd)}</dd>
        </div>
        <div>
          <dt>Request ID</dt>
          <dd>{row.requestId}</dd>
        </div>
        <div>
          <dt>Response record ID</dt>
          <dd>{row.receiptHash ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt>Model that answered</dt>
          <dd>{row.resolvedModel ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>How it ended</dt>
          <dd data-request-end>{endText(row)}</dd>
        </div>
        {row.usage && (
          <div>
            <dt>Tokens</dt>
            <dd>
              {count(row.usage.inputTokens)} input · {count(row.usage.outputTokens)} output
              {row.usage.reasoningTokens !== null &&
                `, ${count(row.usage.reasoningTokens)} of them reasoning`}
            </dd>
          </div>
        )}
        {sampling && (
          <div>
            <dt>Sampling</dt>
            <dd data-request-sampling>{samplingText(sampling)}</dd>
          </div>
        )}
        <div>
          <dt>Images sent</dt>
          <dd data-request-images>
            {images === null ? (
              "Unknown"
            ) : !images.length ? (
              "None"
            ) : (
              <>
                {counted(images.length, "image")}, in request order
                <ol className={s.requestImages}>
                  {images.map((image, index) => (
                    <li key={index}>
                      {image.width} × {image.height}{" "}
                      <code title={image.hash}>{image.hash.slice(0, 12)}</code>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </dd>
        </div>
      </dl>
      {row.issue && <p>{row.issue}</p>}
      <p className={b.support}>
        This page only reads saved records. It does not send the request again or contact the
        provider.
      </p>
      <Link className={s.secondary} href={`/runs/${id}?tab=details`}>
        Open original run and payment recovery
      </Link>
    </main>
  );
}
