"use client";

import { forwardRef, useState } from "react";
import { Barcode, Search } from "lucide-react";
import { usePos } from "@/lib/store";

interface ScanBarProps {
  onScan: (code: string) => void;
  onEmptyEnter: () => void;
}

/**
 * Always-focused input. A USB scanner "types" the code and presses Enter, so a scan and a typed
 * code take the same path. "5*" sets a quantity prefix for the next scan.
 */
export const ScanBar = forwardRef<HTMLInputElement, ScanBarProps>(function ScanBar({ onScan, onEmptyEnter }, ref) {
  const [value, setValue] = useState("");
  const pendingQty = usePos((s) => s.pendingQty);
  const setPendingQty = usePos((s) => s.setPendingQty);
  const notify = usePos((s) => s.notify);

  function submit() {
    const text = value.trim();
    setValue("");
    if (text === "") return onEmptyEnter();
    const prefix = /^(\d{1,3})\*$/.exec(text);
    if (prefix) {
      setPendingQty(Number(prefix[1]));
      notify(`Next item ×${Number(prefix[1])}`, "info");
      return;
    }
    onScan(text);
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border-2 border-primary bg-surface px-3 shadow-sm focus-within:ring-4 focus-within:ring-primary/25">
      <Barcode className="text-primary" size={24} aria-hidden />
      <input
        ref={ref}
        data-scanbar
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        aria-label="Scan barcode or type a code"
        placeholder="Scan barcode or type a code, then Enter   (5* then scan = quantity 5)"
        className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted/70"
      />
      {pendingQty > 1 && (
        <span className="num rounded-md bg-primary px-2 py-0.5 text-sm font-bold text-primary-fg">×{pendingQty}</span>
      )}
      <Search size={18} className="text-muted" aria-hidden />
    </div>
  );
});
