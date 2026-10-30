import Link from "next/link";
import { PageHeading } from "./components/ui";
import s from "./components/workbench.module.css";

export default function NotFound() {
  return (
    <main>
      <PageHeading
        title="This item is no longer available"
        description="The link may point to a removed item or a cleared workspace."
      />
      <div className={s.row}>
        <Link className={s.primary} href="/">
          Go to Benchmarks
        </Link>
        <Link className={s.secondary} href="/?view=activity">
          Open Records
        </Link>
      </div>
    </main>
  );
}
