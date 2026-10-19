"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, Keycap } from "../ui/Dialog";

export interface PickItem {
  id: string;
  title: string;
  subtitle?: string;
  right?: string;
  keys?: string;
  haystack: string; // lower-case text searched
  run: () => void;
}

/** Type-to-filter list shared by product search (F3) and the command palette (Ctrl+K). */
export function PickerDialog({
  title,
  placeholder,
  items,
  empty,
  onClose,
}: {
  title: string;
  placeholder: string;
  items: PickItem[];
  empty: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const shown = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = terms.length ? items.filter((i) => terms.every((t) => i.haystack.includes(t))) : items;
    return list.slice(0, 40);
  }, [items, query]);

  const idx = Math.min(active, Math.max(0, shown.length - 1));

  function run(item?: PickItem) {
    const it = item ?? shown[idx];
    if (!it) return;
    onClose();
    // Let the dialog unmount first so follow-up dialogs aren't closed with it.
    setTimeout(it.run, 0);
  }

  function onKey(e: React.KeyboardEvent): boolean {
    if (e.key === "ArrowDown") return (setActive(Math.min(idx + 1, shown.length - 1)), e.preventDefault(), true);
    if (e.key === "ArrowUp") return (setActive(Math.max(idx - 1, 0)), e.preventDefault(), true);
    return false;
  }

  return (
    <Dialog title={title} onClose={onClose} onConfirm={() => run()} onKey={onKey} width="max-w-xl">
      <div className="flex items-center gap-2 rounded-xl border-2 border-primary px-3">
        <Search size={18} className="text-primary" />
        <input
          data-autofocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder={placeholder}
          aria-label={title}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none"
        />
      </div>
      <ul role="listbox" className="scroll-thin mt-3 max-h-80 overflow-y-auto">
        {shown.map((it, i) => (
          <li key={it.id} role="option" aria-selected={i === idx}>
            <button
              type="button"
              tabIndex={-1}
              ref={(el) => {
                if (el && i === idx) el.scrollIntoView({ block: "nearest" });
              }}
              onMouseMove={() => setActive(i)}
              onClick={() => run(it)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left ${i === idx ? "bg-primary-soft" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{it.title}</span>
                {it.subtitle && <span className="block truncate text-xs text-muted">{it.subtitle}</span>}
              </span>
              {it.keys ? <Keycap>{it.keys}</Keycap> : <span className="num shrink-0 text-sm text-muted">{it.right}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-6 text-center text-muted">{empty}</li>}
      </ul>
      <p className="mt-2 text-xs text-muted">↑/↓ to move · Enter to choose · Esc to close</p>
    </Dialog>
  );
}
