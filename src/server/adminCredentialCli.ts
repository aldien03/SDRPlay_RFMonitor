import { createAdminCredential } from "./adminAuth";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (password.includes("\n") || password.includes("\r")) {
  console.error("Settings password must be supplied as one line on standard input");
  process.exit(1);
}

try {
  process.stdout.write(`${JSON.stringify(await createAdminCredential(password), null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
