"use client";

import { useState } from "react";
import { evaluate } from "@/lib/calc";
import { Dialog } from "../ui/Dialog";

const KEYS = ["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "(", "+", ")", "C", "⌫", "="];

/** Keyboard-first calculator. It never touches the bill (PLAN.md §8). */
export function CalculatorDialog({ onClose }: { onClose: () => void }) {
  const [expr, setExpr] = useState("");
  const [error, setError] = useState(false);

  let preview = "";
  try {
    if (expr.trim() !== "") preview = String(evaluate(expr.replace(/−/g, "-")));
  } catch {
    preview = "";
  }

  function press(k: string) {
    setError(false);
    if (k === "C") return setExpr("");
    if (k === "⌫") return setExpr((e) => e.slice(0, -1));
    if (k === "=") return equals();
    setExpr((e) => e + k);
  }

  function equals() {
    if (expr.trim() === "") return;
    try {
      setExpr(String(evaluate(expr.replace(/−/g, "-"))));
    } catch {
      setError(true);
    }
  }

  return (
    <Dialog title="Calculator" onClose={onClose} onConfirm={equals} width="max-w-xs">
      <input
        data-autofocus
        value={expr}
        onChange={(e) => {
          setError(false);
          setExpr(e.target.value.replace(/[^0-9+\-*/().×÷−\s]/g, ""));
        }}
        inputMode="decimal"
        aria-label="Expression"
        autoComplete="off"
        className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-3 text-right text-2xl font-semibold outline-none"
      />
      <p className={`num mt-1 h-6 text-right text-sm ${error ? "text-danger" : "text-muted"}`} aria-live="polite">
        {error ? "Can't calculate that" : preview && preview !== expr ? `= ${Number(preview).toLocaleString("en-US", { maximumFractionDigits: 6 })}` : ""}
      </p>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            tabIndex={-1}
            onClick={() => press(k)}
            className={`h-11 rounded-lg text-lg font-semibold ${
              k === "=" ? "bg-primary text-primary-fg" : /[0-9.]/.test(k) ? "border border-border bg-surface-2" : "bg-border/60"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">Type with the keyboard · Enter = · Esc closes</p>
    </Dialog>
  );
}
