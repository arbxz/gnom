import { useEffect, useState } from "react";

export interface Settings {
  roots: string[];
  exclude: string[];
  staleDays: number;
  largeFileMb: number;
  toTrash: boolean;
  solid: boolean;
  theme: "system" | "light" | "dark";
}

const KEY = "gnom.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  exclude: [],
  staleDays: 30,
  largeFileMb: 200,
  toTrash: false,
  solid: false,
  theme: "system",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* private mode or blocked storage: fall back to defaults */
  }
  return DEFAULT_SETTINGS;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* not persisted; fine */
    }
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
    root.toggleAttribute("data-solid", settings.solid);
  }, [settings]);
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  return [settings, update] as const;
}
