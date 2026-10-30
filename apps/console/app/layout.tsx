import type { Metadata } from "next";
import "./globals.css";
import Shell from "./components/shell";
import WorkspaceSession from "./components/workspace-session";
import { workspaceIdentity } from "../../../dist/packages/operator/src/workspace.js";
import { repositoryRoot } from "../lib/data";
import { themeScript } from "./components/theme";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Basalt Evals",
  description:
    "Use Basalt Evals to create evaluations, compare models and examine their results in Roblox Studio.",
};
export default async function Layout({ children }: { children: React.ReactNode }) {
  const identity = await workspaceIdentity(repositoryRoot());
  return (
    // The saved appearance is applied before paint, so the server markup cannot know it.
    <html lang="en" data-workspace={identity} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Shell>
          <WorkspaceSession key={identity} identity={identity}>
            {children}
          </WorkspaceSession>
        </Shell>
      </body>
    </html>
  );
}
