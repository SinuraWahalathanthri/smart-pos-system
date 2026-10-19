/**
 * Parses pos_db.html (the BCNF design document) into a machine-readable model.
 *
 * The document is the source of truth for the schema. Generating DDL from it means the database
 * cannot silently drift from the design: if a table or column is added there, the PGlite test
 * fails until the migration matches. Only structured markup is read; prose is ignored.
 */
import { readFileSync } from "node:fs";

export interface Column {
  name: string;
  /** Raw MariaDB type as written in the document. */
  mariadbType: string;
  pk: boolean;
  uq: boolean;
  ix: boolean;
  fk: boolean;
  note: string;
  /** Allowed values, recovered from the note's <code> items for ENUM columns. */
  enumValues?: string[];
}

/** Notes embed identifiers as <code>x</code>; keep them so ENUM values can be recovered. */
const codeItems = (cell: string): string[] =>
  [...cell.matchAll(/<code>(.*?)<\/code>/g)].map((m) => strip(m[1])).filter(Boolean);

/** "created_at / updated_at" with one type expands to two columns sharing that type. */
function splitNames(raw: string): string[] {
  return raw
    .split(/\s*[/·]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Table {
  name: string;
  order: number;
  category: string;
  columns: Column[];
  keySummary: string;
  purpose: string;
}

export interface Model {
  categories: { id: string; title: string; count: number }[];
  tables: Table[];
}

const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

export function parseDesignDoc(htmlPath: string): Model {
  const html = readFileSync(htmlPath, "utf8");

  const categories = [...html.matchAll(
    /<div class="idx-card" data-cat="([a-k])">\s*<h4>[^<]*<span class="badge[^"]*">[A-K]<\/span>\s*([^<]+?)\s*<span class="cnt">(\d+)<\/span>/g,
  )].map((m) => ({ id: m[1], title: strip(m[2]), count: Number(m[3]) }));

  const orderByName = new Map<string, number>();
  for (const m of html.matchAll(/<a href="#t-([a-z0-9_]+)"><span class="n">(\d+)<\/span>/g)) {
    orderByName.set(m[1], Number(m[2]));
  }

  const tables: Table[] = [];
  for (const sec of html.matchAll(
    /<section class="tbl" id="t-([a-z0-9_]+)" data-cat="([a-k])">([\s\S]*?)<\/section>/g,
  )) {
    const [, name, category, body] = sec;

    const columns: Column[] = [];
    for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      if (cells.length < 3) continue;
      const rawName = strip(cells[0]);
      const rawType = strip(cells[1]);
      if (!rawName || !rawType || /^column$/i.test(rawName)) continue;

      const names = splitNames(rawName);
      const types = splitNames(rawType);
      const keys = cells[2] ?? "";
      const noteCell = cells[3] ?? "";
      const note = strip(noteCell);
      const enumValues =
        types.length === 1 && /^ENUM$/i.test(types[0]) ? codeItems(noteCell) : undefined;

      names.forEach((name, i) => {
        columns.push({
          name,
          mariadbType: types.length === names.length ? types[i] : types[0],
          pk: /class="pk"/.test(keys),
          uq: /class="uq"/.test(keys),
          ix: /class="ix"/.test(keys),
          fk: /class="fk"/.test(keys),
          note,
          enumValues,
        });
      });
    }

    const keySummary = strip((body.match(/<p class="keys">([\s\S]*?)<\/p>/) ?? [])[1] ?? "");
    const purpose = strip((body.match(/<p class="purpose">([\s\S]*?)<\/p>/) ?? [])[1] ?? "");

    tables.push({ name, order: orderByName.get(name) ?? 999, category, columns, keySummary, purpose });
  }

  tables.sort((a, b) => a.order - b.order);
  return { categories, tables };
}
