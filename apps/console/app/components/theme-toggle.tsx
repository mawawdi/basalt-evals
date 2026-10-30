"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "@phosphor-icons/react";
import { themeKey } from "./theme";
import s from "./workbench.module.css";

function apply(dark: boolean) {
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    // The switch shows whatever theme the page has, however it was set.
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.theme === "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    // Another tab's choice applies here too.
    const storage = (event: StorageEvent) => {
      if (event.key === themeKey) apply(event.newValue === "dark");
    };
    window.addEventListener("storage", storage);
    return () => {
      observer.disconnect();
      window.removeEventListener("storage", storage);
    };
  }, []);
  return (
    <button
      type="button"
      className={s.themeToggle}
      aria-label="Dark mode"
      aria-pressed={dark}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        const next = !dark;
        apply(next);
        setDark(next);
        try {
          localStorage.setItem(themeKey, next ? "dark" : "light");
        } catch {
          /* Without device storage the choice lasts until this page reloads. */
        }
      }}
    >
      {dark ? <Sun size={20} aria-hidden /> : <Moon size={20} aria-hidden />}
    </button>
  );
}
