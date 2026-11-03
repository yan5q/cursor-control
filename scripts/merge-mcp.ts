import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const target = path.join(homedir(), ".cursor", "mcp.json");
const entry = {
  command: "node",
  args: [path.resolve("server/dist/index.js")],
};

main().then(
  () => undefined,
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);

async function main(): Promise<void> {
  let current: { mcpServers?: Record<string, unknown> } = {};
  try {
    current = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown> };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  current.mcpServers = { ...current.mcpServers, "cursor-browser": entry };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Updated ${target}`);
}
