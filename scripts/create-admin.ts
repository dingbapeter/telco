// Creates or resets a command centre administrator. Run on the server:
//   node scripts/create-admin.ts founder@example.com "Founder"
// The password is typed at a prompt and never appears on screen, in the
// shell history or in any log.
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { createAdmin } from "../src/auth.ts";
import { closePool, withActor } from "../src/db.ts";

const [email, name] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/create-admin.ts <email> "<name>"');
  process.exit(1);
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const write = stdout.write.bind(stdout);
    stdout.write(question);
    // Swallow echo while the password is typed.
    (stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) =>
      typeof chunk === "string" && chunk.includes("\n") ? write("\n") : true;
    rl.question("", (answer) => {
      (stdout as unknown as { write: typeof write }).write = write;
      rl.close();
      resolve(answer);
    });
  });
}

const password = await askHidden("Password (at least 12 characters, not shown): ");
const again = await askHidden("Type it again: ");
if (password !== again) {
  console.error("The two passwords do not match. Nothing was changed.");
  process.exit(1);
}
try {
  const admin = await withActor("cli:create-admin", (c) => createAdmin(c, { email, name: name ?? "", password }));
  console.log(`Administrator ${admin.email} can now log in to the command centre.`);
} finally {
  await closePool();
}
