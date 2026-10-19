/**
 * Single registry of till shortcuts. The key handler, the shortcut bar, the help sheet and the
 * command palette all read from here (DESIGN.md §7.4), so they can never disagree.
 */
export interface Shortcut {
  id: string;
  keys: string; // display label, e.g. "F8"
  label: string;
  group: "Bill" | "Find" | "Payment" | "Tools" | "Navigate";
  bar?: boolean; // shown in the bottom shortcut bar
  barLabel?: string;
}

export const SHORTCUTS: Shortcut[] = [
  { id: "qty", keys: "F2", label: "Change quantity of selected line", group: "Bill", bar: true, barLabel: "Qty" },
  { id: "search", keys: "F3", label: "Find product by name or code", group: "Find", bar: true, barLabel: "Find" },
  { id: "calc", keys: "F4", label: "Calculator", group: "Tools", bar: true, barLabel: "Calc" },
  { id: "customer", keys: "F5", label: "Attach customer", group: "Bill", bar: true, barLabel: "Customer" },
  { id: "discount", keys: "F6", label: "Bill discount", group: "Bill", bar: true, barLabel: "Discount" },
  { id: "bottle", keys: "F7", label: "Bottle returns for the attached customer", group: "Bill", bar: true, barLabel: "Bottles" },
  { id: "void", keys: "F8", label: "Remove line (supervisor badge + PIN)", group: "Bill", bar: true, barLabel: "Void" },
  { id: "hold", keys: "F9", label: "Hold bill, or recall a held bill", group: "Bill", bar: true, barLabel: "Hold" },
  { id: "exact", keys: "F10", label: "Pay exact cash", group: "Payment", bar: true, barLabel: "Exact" },
  { id: "pay", keys: "F12", label: "Pay (or Enter on an empty scan bar)", group: "Payment", bar: true, barLabel: "Pay" },
  { id: "palette", keys: "Ctrl+K", label: "Command palette", group: "Navigate" },
  { id: "help", keys: "?", label: "Show this shortcut sheet", group: "Navigate" },
  { id: "lock", keys: "Ctrl+L", label: "Lock the till", group: "Navigate" },
  { id: "up", keys: "↑ / ↓", label: "Select previous / next bill line", group: "Bill" },
  { id: "plusminus", keys: "+ / −", label: "Change quantity of selected line", group: "Bill" },
  { id: "del", keys: "Del", label: "Remove selected line (supervisor)", group: "Bill" },
  { id: "prefix", keys: "5*", label: "Quantity prefix: type 5* then scan to add 5", group: "Find" },
  { id: "cat", keys: "Ctrl+1…9", label: "Switch product category", group: "Find" },
  { id: "esc", keys: "Esc", label: "Close dialog, return to the scan bar", group: "Navigate" },
];

/** Map a KeyboardEvent to a shortcut id, or null. Plain characters are handled elsewhere. */
export function shortcutForEvent(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "k") return "palette";
    if (e.key.toLowerCase() === "l") return "lock";
    return null;
  }
  if (e.altKey) return null;
  switch (e.key) {
    case "F2": return "qty";
    case "F3": return "search";
    case "F4": return "calc";
    case "F5": return "customer";
    case "F6": return "discount";
    case "F7": return e.shiftKey ? "bottle-undo" : "bottle";
    case "F8": return "void";
    case "F9": return "hold";
    case "F10": return "exact";
    case "F12": return "pay";
    default: return null;
  }
}
