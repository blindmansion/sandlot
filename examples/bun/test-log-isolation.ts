/**
 * Test script to verify that sandboxed logs are isolated from the host console.
 * 
 * Expected behavior:
 * - Logs from sandboxed code should NOT appear directly in this terminal
 * - Logs from sandboxed code SHOULD appear in result.logs
 * - Only our explicit console.log calls should appear in this terminal
 */

import { createNodeSandlot } from "sandlot/node";

console.log("=".repeat(60));
console.log("Log Isolation Test");
console.log("=".repeat(60));
console.log("");
console.log("If log isolation is working correctly, you should NOT see");
console.log("'SANDBOXED LOG' messages appear directly below this line.");
console.log("They should ONLY appear in the 'Captured logs' section.");
console.log("");
console.log("─".repeat(60));

const sandlot = await createNodeSandlot();
const sandbox = await sandlot.createSandbox();

// Write code that logs various things
sandbox.writeFile(
  "/index.ts",
  `
console.log("SANDBOXED LOG: This is a regular log");
console.warn("SANDBOXED LOG: This is a warning");
console.error("SANDBOXED LOG: This is an error");
console.info("SANDBOXED LOG: This is info");
console.debug("SANDBOXED LOG: This is debug");

export function main() {
  console.log("SANDBOXED LOG: Inside main function");
  return { success: true };
}
`
);

const result = await sandbox.run({ skipTypecheck: true });

console.log("─".repeat(60));
console.log("");
console.log("Execution complete. Now showing captured logs:");
console.log("");
console.log("─".repeat(60));
console.log("Captured logs from result.logs:");
console.log("─".repeat(60));

for (const log of result.logs) {
  console.log(`  ${log}`);
}

console.log("─".repeat(60));
console.log("");
console.log("Return value:", result.returnValue);
console.log("");
console.log("=".repeat(60));
console.log("Test complete!");
console.log("");
console.log("✓ If you saw 'SANDBOXED LOG' messages ONLY in the 'Captured logs'");
console.log("  section above, then log isolation is working correctly.");
console.log("");
console.log("✗ If you saw 'SANDBOXED LOG' messages appear twice (once directly");
console.log("  and once in 'Captured logs'), then isolation is broken.");
console.log("=".repeat(60));

await sandlot.dispose();
