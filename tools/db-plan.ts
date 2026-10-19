/**
 * `npm run db:plan` - regenerate supabase/design/0005_core_schema.sql from pos_db.html.
 *
 * Run after editing the design document. The generated file is committed so a fresh clone can apply
 * migrations without running this tool, and the PGlite test fails if the two ever disagree.
 */
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDesignDoc } from "./design-doc";
import { generatePostgres } from "./ddl";

const ROOT = join(__dirname, "..");
// Not migrations/: this file is the full design-document schema and collides with 0001.
// It is a reference artifact until the reconciliation decision is made.
const OUT_DIR = join(ROOT, "supabase", "design");

const model = parseDesignDoc(join(ROOT, "pos_db.html"));
const generated = generatePostgres(model);

if (!generated.warnings.length) {
  console.log("FK resolution: no warnings");
} else {
  console.log(`FK resolution: ${generated.warnings.length} warning(s)`);
  for (const w of generated.warnings) console.log("  ! " + w);
}

const existing = readdirSync(OUT_DIR).find((f) => f.startsWith("0005_"));
const name = existing ?? "0005_core_schema.sql";
const out = join(OUT_DIR, name);
writeFileSync(out, generated.sql, "utf8");

console.log(
  `wrote ${name}: ${generated.stats.tables} tables, ${generated.stats.columns} columns, ` +
    `${generated.stats.enums} enum types, ${generated.stats.indexes} indexes`,
);
