"use client";
import { useEffect } from "react";

// Tab-local retention survives internal navigation when browser storage is denied.
// It is never described as a device or server save.
export const draftMemory = new Map<string, unknown>();

export function useUnsavedGuard(unsaved: () => boolean, blocked: () => void) {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]");
      if (!link || !unsaved() || (link as HTMLAnchorElement).target === "_blank") return;
      const destination = new URL((link as HTMLAnchorElement).href);
      if (
        destination.href === location.href ||
        (destination.hash && destination.pathname === location.pathname)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      blocked();
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("click", click, true);
    window.addEventListener("beforeunload", leave);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("beforeunload", leave);
    };
  });
}
