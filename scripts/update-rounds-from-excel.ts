import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";

// Refresh ONLY the 4 interview-round competency columns on jobs that already
// exist in the DB, matched by Source URL. Nothing else is touched (no embeddings,
// no JobSkill/JobCapability rebuild). Dry-run by default; --confirm to write.
//   tsx scripts/update-rounds-from-excel.ts                 # dry run, default files
//   tsx scripts/update-rounds-from-excel.ts --confirm       # apply
//   tsx scripts/update-rounds-from-excel.ts a.xlsx b.xlsx   # custom files

const DEFAULT_FILES = [
  "/Users/mohammedhasan/Downloads/exports/linkedin_jobs.xlsx",
  "/Users/mohammedhasan/Downloads/exports/naukri_jobs.xlsx",
];

// Excel header -> Job column. Source URL is the match key.
const URL_HEADER = "Source URL";
const ROUND_COLUMNS = {
  Screening: "roundScreening",
  Behavioural: "roundBehavioural",
  Technical: "roundTechnical",
  "Culture fit": "roundCultureFit",
} as const;

type RoundField = (typeof ROUND_COLUMNS)[keyof typeof ROUND_COLUMNS];

const connectionString = process.env.ROUND_DB_URL;
if (!connectionString) throw new Error("ROUND_DB_URL is required");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

function cellText(cell: ExcelJS.Cell): string {
  // .text renders rich text / hyperlinks / numbers consistently.
  return (cell.text ?? "").trim();
}

// Map header label -> 1-based column index from row 1.
function headerIndex(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  const header = sheet.getRow(1);
  header.eachCell((cell, col) => {
    const label = cellText(cell);
    if (label) map.set(label, col);
  });
  return map;
}

type FileResult = {
  file: string;
  rows: number;
  matched: number;
  updated: number;
  unchanged: number;
  unmatched: { sourceUrl: string; title: string }[];
};

async function processFile(file: string, confirm: boolean): Promise<FileResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0];
  const idx = headerIndex(sheet);

  const missing = [URL_HEADER, ...Object.keys(ROUND_COLUMNS)].filter((h) => !idx.has(h));
  if (missing.length) throw new Error(`${file}: missing columns: ${missing.join(", ")}`);

  const urlCol = idx.get(URL_HEADER)!;
  const titleCol = idx.get("Job title");

  const result: FileResult = {
    file,
    rows: 0,
    matched: 0,
    updated: 0,
    unchanged: 0,
    unmatched: [],
  };

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const sourceUrl = cellText(row.getCell(urlCol));
    const title = titleCol ? cellText(row.getCell(titleCol)) : "";
    if (!sourceUrl) continue; // skip blank/spacer rows
    result.rows++;

    const jobs = await prisma.job.findMany({
      where: { sourceUrl },
      select: {
        id: true,
        roundScreening: true,
        roundBehavioural: true,
        roundTechnical: true,
        roundCultureFit: true,
      },
    });

    if (jobs.length === 0) {
      result.unmatched.push({ sourceUrl, title });
      continue;
    }
    if (jobs.length > 1) {
      console.warn(`  WARN multiple jobs (${jobs.length}) for sourceUrl, updating all: ${sourceUrl}`);
    }
    result.matched++;

    // Build update from non-empty round cells that differ from stored value.
    const data: Partial<Record<RoundField, string>> = {};
    for (const [header, field] of Object.entries(ROUND_COLUMNS) as [string, RoundField][]) {
      const value = cellText(row.getCell(idx.get(header)!));
      if (value && value !== jobs[0][field]) data[field] = value;
    }

    if (Object.keys(data).length === 0) {
      result.unchanged++;
      continue;
    }
    result.updated++;
    if (confirm) {
      for (const job of jobs) await prisma.job.update({ where: { id: job.id }, data });
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const files = args.filter((a) => !a.startsWith("--"));
  const targets = files.length ? files : DEFAULT_FILES;

  console.log(`Mode: ${confirm ? "CONFIRM (writing)" : "dry-run"}`);
  const results: FileResult[] = [];
  for (const file of targets) {
    console.log(`\nProcessing ${file} ...`);
    const res = await processFile(file, confirm);
    results.push(res);
    console.log(
      JSON.stringify(
        { rows: res.rows, matched: res.matched, updated: res.updated, unchanged: res.unchanged, unmatched: res.unmatched.length },
        null,
        2,
      ),
    );
    if (res.unmatched.length) {
      console.log("  Unmatched (no DB job for this Source URL):");
      for (const u of res.unmatched) console.log(`    - ${u.title} | ${u.sourceUrl}`);
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      rows: acc.rows + r.rows,
      matched: acc.matched + r.matched,
      updated: acc.updated + r.updated,
      unchanged: acc.unchanged + r.unchanged,
      unmatched: acc.unmatched + r.unmatched.length,
    }),
    { rows: 0, matched: 0, updated: 0, unchanged: 0, unmatched: 0 },
  );
  console.log("\nTOTAL:", JSON.stringify(totals));
  if (!confirm) console.log("\nDry run only. Re-run with --confirm to write to ROUND_DB_URL.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
