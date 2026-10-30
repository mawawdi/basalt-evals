import Link from "next/link";
import { readModelRegistry } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import { PageHeading } from "../components/ui";
import s from "../components/workbench.module.css";
import { ModelManager } from "./model-manager";
export const metadata = { title: "Models · Basalt" };
export const dynamic = "force-dynamic";
export default async function Models() {
  return (
    <main>
      <PageHeading
        title="Models"
        description="Add models from the OpenRouter catalog and test them on the same evaluations. Each request goes to the model’s fastest provider that meets the run’s test conditions."
        action={
          <Link href="/runs/new" className={s.primary}>
            Run a benchmark
          </Link>
        }
      />
      <ModelManager initial={await readModelRegistry(repositoryRoot())} />
      <p className={s.small}>
        The free preview saves the exact model, providers and prices before you start.
      </p>
    </main>
  );
}
