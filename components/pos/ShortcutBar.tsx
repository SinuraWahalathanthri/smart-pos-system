"use client";

import { Keycap } from "../ui/Dialog";
import { SHORTCUTS } from "@/lib/shortcuts";

/** Bottom strip of active shortcuts; each is also a button (mouse works for everything). */
export function ShortcutBar({ onRun }: { onRun: (id: string) => void }) {
  return (
    <nav aria-label="Shortcuts" className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface px-3">
      {SHORTCUTS.filter((s) => s.bar).map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onRun(s.id)}
          title={s.label}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
        >
          <Keycap>{s.keys}</Keycap>
          {s.barLabel}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onRun("help")}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
      >
        <Keycap>?</Keycap> All shortcuts
      </button>
    </nav>
  );
}
