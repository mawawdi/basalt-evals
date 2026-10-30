"use client";

import { Notice } from "../../components/ui";
import s from "../../components/workbench.module.css";
import {
  providerPauseSentence,
  type ProviderPauseView,
} from "../../../../../dist/packages/contracts/src/console.js";

/** The provider pause of a run in one plain sentence, with Resume when the run allows it. */
export function ProviderPauseNotice(props: {
  pauses: ProviderPauseView[];
  canResume: boolean;
  busy: boolean;
  onResume: () => void;
}) {
  const sentence = providerPauseSentence(props.pauses);
  if (!sentence) return null;
  return (
    <Notice>
      <span data-provider-pause>{sentence}</span>
      {props.canResume && (
        <div className={s.noticeAction}>
          <button className={s.primary} disabled={props.busy} onClick={props.onResume}>
            Resume
          </button>
        </div>
      )}
    </Notice>
  );
}

/** The log of a build or a judge check, beside its line in the activity. */
export function UnitLogLink(props: {
  operationId: string;
  stage: string | null;
  unitId: string | null;
}) {
  if ((props.stage !== "builder" && props.stage !== "judgment") || !props.unitId) return null;
  return (
    <a
      className={s.action}
      href={`/api/runs/${props.operationId}/units/${props.stage}-${props.unitId}/log`}
      target="_blank"
      rel="noreferrer"
    >
      View log
    </a>
  );
}
