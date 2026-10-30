import { randomUUID } from "node:crypto";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { ReviewerProfile, ReviewBatch } from "../../contracts/src/review.js";
import { ReviewConflict } from "./review-store.js";

export function requireReviewer(journal: OperationJournal, id: string): ReviewerProfile {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/u.test(id))
    throw new ReviewConflict("Choose a reviewer profile before you start a review.");
  const profile = journal.read<ReviewerProfile>("reviewers", id);
  if (!profile || profile.id !== id)
    throw new ReviewConflict(
      "Basalt cannot find this reviewer profile. Choose a different profile.",
    );
  return profile;
}
export function requireReviewActor(
  journal: OperationJournal,
  batch: ReviewBatch,
  reviewer: string,
) {
  const profile = requireReviewer(journal, reviewer);
  if (profile.id !== batch.reviewer)
    throw new ReviewConflict(
      "This review belongs to another reviewer. Use the profile of that reviewer to open it.",
    );
  return profile;
}
export async function reviewerProfile(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return requireReviewer(journal, id);
  } finally {
    journal.close();
  }
}
export async function listReviewers(root: string, params = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.page<ReviewerProfile>("reviewers", {
      q: params.get("q") ?? "",
      page: Number(params.get("page") ?? 1),
      limit: Number(params.get("limit") ?? 20),
    });
  } finally {
    journal.close();
  }
}
export async function createReviewer(root: string, displayName: string): Promise<ReviewerProfile> {
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.trim().length > 100 ||
    /[\u0000-\u001f]/u.test(displayName)
  )
    throw new Error("Enter a reviewer name of 1 to 100 characters.");
  const profile = {
    id: randomUUID(),
    displayName: displayName.trim(),
    createdAt: new Date().toISOString(),
  };
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      journal.put("reviewers", profile.id, profile);
      journal.project("reviewers", profile.id, {
        search: profile.displayName,
        status: "",
        sort: profile.createdAt,
        body: profile,
      });
    });
    return profile;
  } finally {
    journal.close();
  }
}
