export const metadata = { title: "Author evaluation · Basalt" };
import {
  textDraft,
  workflowRecord,
  authoringClarifications,
  readLibraryEvaluation,
  libraryEvaluationForDraft,
} from "../../../lib/server";
import { notFound } from "next/navigation";
import { repositoryRoot } from "../../../lib/data";
import { EvaluationEditor } from "../../components/evaluation-editor";
export const dynamic = "force-dynamic";
export default async function NewEvaluation({
  searchParams,
}: {
  searchParams: Promise<{
    evaluation?: string;
    duplicate?: string;
    draft?: string;
    workflow?: string;
  }>;
}) {
  const params = await searchParams,
    root = repositoryRoot();
  const workflow = params.workflow ? await workflowRecord(root, params.workflow) : null;
  const clarification = workflow ? await authoringClarifications(root, workflow.id) : null;
  const selected = params.evaluation ?? params.duplicate;
  const evaluation = selected ? await readLibraryEvaluation(root, selected) : null;
  if (selected && !evaluation) notFound();
  const draft = evaluation?.draftId ?? params.draft ?? clarification?.draftId;
  const editing = params.duplicate
    ? null
    : (evaluation ?? (draft ? await libraryEvaluationForDraft(root, draft) : null));
  const questions = clarification?.questions ?? [];
  return (
    <EvaluationEditor
      initialDraft={draft ? await textDraft(root, draft) : undefined}
      initialEvaluation={editing ?? undefined}
      duplicating={Boolean(params.duplicate) || Boolean(draft && !editing)}
      questions={questions}
    />
  );
}
