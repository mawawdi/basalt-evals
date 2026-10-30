import type { StudioCollectionPlan } from "../../contracts/src/index.js";

export interface StudioSession {
  schema: "basalt-evals/studio-session";
  id: string;
  token: string;
  connectorUrl: string;
  treatmentId: string;
  candidateHash: string;
  collectionPlanHash: string;
  connectorSourceHash: string;
  connectorArtifactHash: string;
  expectedStudioVersion: string;
  place: { file: string; hash: string };
  plan: StudioCollectionPlan;
  createdAt: string;
}
