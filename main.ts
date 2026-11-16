import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import { boardIssue, buildRadar, dataScript, parseSnapshot, type Snapshot } from "./lib/model.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function argumentsFrom(argv: string[]): { input: string; output: string } {
  let input = "/input";
  let output = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--input" && option !== "--output") {
      throw new Error(`Unknown argument: ${option}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Expected a path after ${option}`);
    }
    if (option === "--input") input = value;
    else output = value;
    index += 1;
  }
  return { input, output };
}

function snapshotPath(input: string): string {
  const resolved = resolve(input);
  try {
    if (statSync(resolved).isDirectory()) return join(resolved, "snapshot.json");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  return resolved;
}

function copyDashboard(
  source: string,
  destination: string,
  written: string[],
  relativeDirectory = "",
): void {
  const entries = readdirSync(source, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => compareNames(left.name, right.name));
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const relativePath = relativeDirectory === ""
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyDashboard(from, to, written, relativePath);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      written.push(`dashboard/${relativePath}`);
    }
  }
}

function copyScreenshots(source: string, destination: string, written: string[]): void {
  const entries = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .sort((left, right) => compareNames(left.name, right.name));
  if (entries.length < 3) {
    throw new Error(`screenshots/ must contain at least 3 regular files (found ${entries.length})`);
  }
  for (const entry of entries) {
    if (!SCREENSHOT_NAME.test(entry.name)) {
      throw new Error(`Invalid screenshot name: ${entry.name}`);
    }
    copyFileSync(join(source, entry.name), join(destination, entry.name));
    written.push(`screenshots/${entry.name}`);
  }
}

function run(): void {
  let paths: { input: string; output: string };
  try {
    paths = argumentsFrom(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let inputFile: string;
  try {
    inputFile = snapshotPath(paths.input);
  } catch (error) {
    console.error(`Cannot resolve snapshot input ${paths.input}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  let inputStats;
  try {
    inputStats = statSync(inputFile);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      console.error(`Snapshot file not found: ${inputFile}`);
      process.exitCode = 2;
      return;
    }
    console.error(`Cannot read snapshot file ${inputFile}: ${String(error)}`);
    process.exitCode = 1;
    return;
  }
  if (!inputStats.isFile()) {
    console.error(`Snapshot path is not a file: ${inputFile}`);
    process.exitCode = 1;
    return;
  }

  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(readFileSync(inputFile, "utf8"));
  } catch (error) {
    console.error(`Cannot parse snapshot ${inputFile}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const { board, radar } = buildRadar(snapshot);
  // Keep the output untouched unless the board passes every release gate.
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    console.error(`Board rejected: ${issue}`);
    process.exitCode = 1;
    return;
  }

  try {
    const output = resolve(paths.output);
    mkdirSync(output, { recursive: true });
    const written: string[] = [];

    const boardPath = join(output, "board.json");
    writeFileSync(boardPath, `${JSON.stringify({ rows: board })}\n`);
    written.push("board.json");

    const dataPath = join(output, "data.js");
    const dashboardRadar = {
      ...radar,
      rows: radar.rows.map((row, index) => ({
        ...row,
        category: board[index].category,
        chains: board[index].chains,
        tvl_usd: board[index].tvl_usd,
        change_7d: board[index].change_7d,
      })),
    };
    writeFileSync(dataPath, dataScript(dashboardRadar));
    written.push("data.js");

    const dashboardOut = join(output, "dashboard");
    mkdirSync(dashboardOut, { recursive: true });
    copyDashboard(join(ROOT, "dashboard"), dashboardOut, written);

    const screenshotsOut = join(output, "screenshots");
    mkdirSync(screenshotsOut, { recursive: true });
    copyScreenshots(join(ROOT, "screenshots"), screenshotsOut, written);

    const dossierPath = join(output, "dossier.json");
    writeFileSync(dossierPath, buildDossier(output, {
      text_max_bytes: 65536,
      screenshots: { max: 4, max_bytes: 524288 },
      dashboard: { max_files: 400, max_bytes: 4194304 },
    }));
    written.push("dossier.json");

    console.log(
      `protocols=${snapshot.protocols.length} watchlist=${snapshot.watchlist.length} `
      + `board=${board.length} files=${written.join(",")}`,
    );
  } catch (error) {
    console.error(`Failed to write output: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

run();
