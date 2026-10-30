export const metadata = { title: "Settings · Basalt" };
import { localReadiness, nativeStudioAdapter } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import { PageHeading } from "../components/ui";
import SetupChecks from "./setup-checks";
import Link from "next/link";
import s from "../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function Setup({
  searchParams,
}: {
  searchParams: Promise<{ return?: string }>;
}) {
  // Settings also runs the read-only Studio preflight. It uses SSH and never starts Studio.
  const checks = await localReadiness(repositoryRoot(), nativeStudioAdapter);
  const returning = (await searchParams).return;
  return (
    <main>
      <PageHeading
        title="Settings"
        description="Check what Basalt needs to run models and collect evidence in Studio."
        action={
          returning?.startsWith("/runs/new?") && (
            <Link className={s.primary} href={returning}>
              Back to your run setup
            </Link>
          )
        }
      />
      <SetupChecks initial={checks} />
    </main>
  );
}
