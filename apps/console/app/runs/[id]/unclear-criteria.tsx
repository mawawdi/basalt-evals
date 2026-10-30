"use client";

import { useEffect, useState } from "react";
import { read } from "../../components/api";
import s from "../../components/workbench.module.css";

interface Question {
  id: string;
  message: string;
  stage: number;
  passage: { text: string } | null;
}

/**
 * The success criteria that preparation could not turn into checks, each in the person's own
 * words with the reason. The person edits these criteria; Basalt never answers them.
 */
export function UnclearCriteria({ base }: { base: string }) {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read<{ questions: Question[] }>(`${base}/clarifications`, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setQuestions(value.questions);
      })
      // The notice keeps its own sentence, so a failed load only hides the list.
      .catch(() => {});
    return () => controller.abort();
  }, [base]);
  if (!questions?.length) return null;
  // A stage name helps only when the evaluation has more than one stage.
  const staged = questions.some((question) => question.stage > 1);
  return (
    <ul className={s.unclearCriteria} aria-label="Unclear success criteria">
      {questions.map((question) => (
        <li key={question.id}>
          {question.passage ? (
            <q>
              {staged && `Stage ${question.stage}: `}
              {question.passage.text.replace(/^\s*[-*+]\s+/u, "").trim()}
            </q>
          ) : (
            <q>{staged ? `Stage ${question.stage}` : "The success criteria"}</q>
          )}
          <span>{question.message}</span>
        </li>
      ))}
    </ul>
  );
}
