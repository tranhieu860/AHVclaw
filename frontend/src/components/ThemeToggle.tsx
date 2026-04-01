"use client";
import { useState, useEffect } from "react";
import { Sun, Moon } from "lucide-react";

const lightCSS = "html.light-mode,html.light-mode body{background:#f5f5f5!important;color:#18181b!important}html.light-mode .bg-zinc-900{background:#fff!important;border-color:#e4e4e7!important}html.light-mode .bg-zinc-950{background:#f5f5f5!important}html.light-mode .bg-zinc-800{background:#f4f4f5!important}html.light-mode .border-zinc-800{border-color:#e4e4e7!important}html.light-mode .text-white{color:#18181b!important}html.light-mode .text-zinc-100{color:#27272a!important}html.light-mode .text-zinc-400{color:#71717a!important}html.light-mode .text-zinc-500{color:#a1a1aa!important}html.light-mode textarea,html.light-mode input{color:#18181b!important}";

export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    if (localStorage.getItem("theme") === "light") {
      setDark(false);
      applyLight();
    }
  }, []);

  const applyLight = () => {
    document.documentElement.classList.add("light-mode");
    if (!document.getElementById("theme-css")) {
      const s = document.createElement("style");
      s.id = "theme-css";
      s.textContent = lightCSS;
      document.head.appendChild(s);
    }
  };

  const applyDark = () => {
    document.documentElement.classList.remove("light-mode");
    document.getElementById("theme-css")?.remove();
  };

  const toggle = () => {
    const next = !dark;
    setDark(next);
    next ? applyDark() : applyLight();
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <button onClick={toggle} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition" title={dark ? "Light mode" : "Dark mode"}>
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
