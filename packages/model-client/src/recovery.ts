import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { hashJson, stableJson } from "../../contracts/src/index.js";
import {
  knownChargeUsd,
  reconcileRetainedModelBilling,
  validImageInputs,
  type RequestImageInput,
} from "./bounded-client.js";
import {
  MAX_MODEL_RESPONSE_BYTES,
  type ModelResponseIdentity,
  type ModelTurnResult,
} from "./contracts.js";
import { DurableSpendLedger } from "./ledger.js";
import { modelRoute, type ModelSnapshot } from "./catalog.js";
import { openRouterModelClientDescriptor } from "./openrouter-ai-sdk.js";
import type { ModelClient } from "./contracts.js";

/** A matching descriptor for consuming receipts, with no dispatch implementation or credentials. */
export function retainedResponseClient(models: ModelSnapshot[]): ModelClient {
  return {
    descriptor: openRouterModelClientDescriptor(
      models.map((model) => model.id),
      Object.fromEntries(models.map((model) => [model.id, modelRoute(model)])),
    ),
    async complete() {
      throw new Error("Retained-response inspection cannot dispatch a model");
    },
  };
}

export interface BillingRecovery {
  requestId: string;
  outcome: "reconciled" | "unresolved";
  reason: string;
}

/**
 * One read-only lookup per known generation, without repeating any model request. A saved
 * provider rejection settles at zero without a lookup.
 */
export async function reconcileSavedModelBilling(
  ledger: DurableSpendLedger,
  lookup: (generationId: string) => Promise<{ generationId: string; costUsd: number }>,
): Promise<BillingRecovery[]> {
  const state = await ledger.read();
  const results: BillingRecovery[] = [];
  for (const entry of state.entries.filter((item) => item.status === "pending")) {
    const directory = resolve(ledger.directory, "model-receipts", hashJson(entry.stage));
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (names.length > 10_000) throw new Error("Too many retained model receipts");
    let recovered = false;
    let reason = "No bound response identity is available; the request will not be repeated";
    for (const name of names
      .filter((name) => /^[1-9][0-9]{0,5}\.(?:response|identity|local-failure)\.json$/u.test(name))
      .sort((a, b) => Number(b.includes("response")) - Number(a.includes("response")))) {
      const retained = JSON.parse(
        (
          await readBoundedRegularFile(
            resolve(directory, name),
            MAX_MODEL_RESPONSE_BYTES,
            "retained model action",
          )
        ).toString("utf8"),
      ) as {
        requestId: string;
        requestHash: string;
        result?: ModelTurnResult;
        resultHash?: string;
        imageInputs?: RequestImageInput[];
        costUsd?: number | null;
      } & Partial<ModelResponseIdentity>;
      if (retained.requestId !== entry.requestId) continue;
      const ordinal = Number(name.split(".")[0]);
      if (
        retained.requestHash !== entry.requestHash ||
        DurableSpendLedger.requestId(`${entry.stage}:${ordinal}`, retained.requestHash) !==
          entry.requestId
      )
        throw new Error(
          "A saved response does not match its saved request. Basalt cannot confirm its charge.",
        );
      try {
        if (name.endsWith("local-failure.json")) {
          if (retained.costUsd !== 0) throw new Error("Local failure has an invalid charge");
          await ledger.reconcile(entry.requestId, 0);
          reason = "Retained local rejection released its unused reservation";
        } else if (retained.result) {
          if (
            retained.resultHash !== hashJson(retained.result) ||
            retained.result.requestHash !== retained.requestHash ||
            !validImageInputs(retained.imageInputs)
          )
            throw new Error("Retained model result changed");
          const known = knownChargeUsd(retained.result);
          if (known !== null) {
            const receipt = {
              requestId: entry.requestId,
              requestHash: entry.requestHash,
              imageInputs: retained.imageInputs,
              result: retained.result,
              resultHash: retained.resultHash,
            };
            const path = resolve(directory, `${ordinal}.json`);
            try {
              await publishImmutable(path, stableJson(receipt) + "\n");
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== "EEXIST" ||
                hashJson(
                  JSON.parse(
                    (
                      await readBoundedRegularFile(path, MAX_MODEL_RESPONSE_BYTES, "model receipt")
                    ).toString("utf8"),
                  ),
                ) !== hashJson(receipt)
              )
                throw error;
            }
            await ledger.reconcile(entry.requestId, known);
          } else await reconcileRetainedModelBilling(ledger, entry.stage, ordinal, lookup);
          reason = "Bound model response and billing are retained";
        } else {
          if (!retained.generationId) continue;
          const billing =
            retained.costUsd === null || retained.costUsd === undefined
              ? await lookup(retained.generationId)
              : { generationId: retained.generationId, costUsd: retained.costUsd };
          if (
            billing.generationId !== retained.generationId ||
            !Number.isFinite(billing.costUsd) ||
            billing.costUsd < 0
          )
            throw new Error("Generation lookup did not return the bound charge");
          const record = {
            requestId: entry.requestId,
            requestHash: entry.requestHash,
            identityHash: hashJson(retained),
            billing,
            responseUnavailable: true,
          };
          const path = resolve(directory, `${ordinal}.identity-billing.json`);
          try {
            await publishImmutable(path, stableJson(record) + "\n");
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              hashJson(
                JSON.parse(
                  (await readBoundedRegularFile(path, 65536, "billing receipt")).toString("utf8"),
                ),
              ) !== hashJson(record)
            )
              throw error;
          }
          await ledger.reconcile(entry.requestId, billing.costUsd);
          reason =
            "Billing recovered; no assistant response is available and none will be invented";
        }
        recovered = true;
      } catch (error) {
        reason = error instanceof Error ? error.message : "Read-only billing lookup failed";
      }
      break;
    }
    results.push({
      requestId: entry.requestId,
      outcome: recovered ? "reconciled" : "unresolved",
      reason,
    });
  }
  return results;
}
