import { createNodeSandlot } from "sandlot/node";

console.log("=".repeat(60));
console.log("Sandlot File Operations Tests");
console.log("=".repeat(60));

const sandlot = await createNodeSandlot();
const sandbox = await sandlot.createSandbox();

// Helper to run a test case
async function runTest(name: string, fn: () => Promise<void> | void) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("─".repeat(60));
  try {
    await fn();
    console.log(`✓ ${name} passed`);
  } catch (err) {
    console.error(`✗ ${name} failed:`, err);
  }
}

// =============================================================================
// Test 1: Basic readFile with line numbers
// =============================================================================
await runTest("readFile returns content with line numbers", async () => {
  sandbox.writeFile(
    "/test-read.ts",
    `const x = 1;
const y = 2;
const z = 3;
console.log(x + y + z);`
  );
  
  const content = sandbox.readFile("/test-read.ts");
  console.log("Full file with line numbers:");
  console.log(content);
  
  // Verify line numbers are present
  if (!content.includes("1|const x = 1;")) {
    throw new Error("Line 1 should have line number prefix");
  }
  if (!content.includes("4|console.log")) {
    throw new Error("Line 4 should have line number prefix");
  }
});

// =============================================================================
// Test 2: readFile with offset
// =============================================================================
await runTest("readFile with offset", async () => {
  sandbox.writeFile(
    "/test-offset.ts",
    `line 0
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9`
  );
  
  // Read starting from line 5 (0-indexed)
  const content = sandbox.readFile("/test-offset.ts", { offset: 5 });
  console.log("Lines starting at offset 5:");
  console.log(content);
  
  // Should start with line 6 (1-indexed in output)
  if (!content.includes("6|line 5")) {
    throw new Error("Should start at line 6 (0-indexed line 5)");
  }
  // Should NOT contain earlier lines
  if (content.includes("line 0") || content.includes("line 4")) {
    throw new Error("Should not contain lines before offset");
  }
});

// =============================================================================
// Test 3: readFile with limit
// =============================================================================
await runTest("readFile with limit", async () => {
  sandbox.writeFile(
    "/test-limit.ts",
    `line 0
line 1
line 2
line 3
line 4
line 5`
  );
  
  // Read only first 3 lines
  const content = sandbox.readFile("/test-limit.ts", { limit: 3 });
  console.log("First 3 lines:");
  console.log(content);
  
  // Should contain lines 1-3
  if (!content.includes("1|line 0") || !content.includes("3|line 2")) {
    throw new Error("Should contain lines 1-3");
  }
  // Should NOT contain line 4 or later
  if (content.includes("line 3") && content.includes("4|")) {
    throw new Error("Should not contain lines beyond limit");
  }
});

// =============================================================================
// Test 4: readFile with offset and limit
// =============================================================================
await runTest("readFile with offset and limit", async () => {
  sandbox.writeFile(
    "/test-offset-limit.ts",
    `line 0
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9`
  );
  
  // Read 3 lines starting at offset 3
  const content = sandbox.readFile("/test-offset-limit.ts", { offset: 3, limit: 3 });
  console.log("3 lines starting at offset 3:");
  console.log(content);
  
  // Should contain lines 4, 5, 6 (1-indexed: 4, 5, 6)
  if (!content.includes("4|line 3") || !content.includes("6|line 5")) {
    throw new Error("Should contain lines 4-6");
  }
  // Count lines
  const lineCount = content.split("\n").length;
  if (lineCount !== 3) {
    throw new Error(`Expected 3 lines, got ${lineCount}`);
  }
});

// =============================================================================
// Test 5: readFileRaw returns content without line numbers
// =============================================================================
await runTest("readFileRaw returns raw content", async () => {
  const originalContent = `export const x = 1;
export const y = 2;`;
  
  sandbox.writeFile("/test-raw.ts", originalContent);
  
  const rawContent = sandbox.readFileRaw("/test-raw.ts");
  console.log("Raw content:");
  console.log(rawContent);
  
  // Should match exactly
  if (rawContent !== originalContent) {
    throw new Error("readFileRaw should return exact original content");
  }
  // Should NOT have line numbers
  if (rawContent.includes("|export")) {
    throw new Error("readFileRaw should not include line numbers");
  }
});

// =============================================================================
// Test 6: editFile replaces single occurrence
// =============================================================================
await runTest("editFile replaces single occurrence", async () => {
  sandbox.writeFile(
    "/test-edit.ts",
    `const x = 1;
const y = 2;
const z = 3;`
  );
  
  // Replace y = 2 with y = 42
  sandbox.editFile("/test-edit.ts", {
    oldString: "const y = 2;",
    newString: "const y = 42;",
  });
  
  const content = sandbox.readFileRaw("/test-edit.ts");
  console.log("After edit:");
  console.log(content);
  
  if (!content.includes("const y = 42;")) {
    throw new Error("Edit should have replaced y = 2 with y = 42");
  }
  if (content.includes("const y = 2;")) {
    throw new Error("Original y = 2 should be gone");
  }
});

// =============================================================================
// Test 7: editFile fails on multiple occurrences without replaceAll
// =============================================================================
await runTest("editFile fails on multiple occurrences", async () => {
  sandbox.writeFile(
    "/test-edit-multi.ts",
    `const x = 1;
const x = 2;
const x = 3;`
  );
  
  try {
    sandbox.editFile("/test-edit-multi.ts", {
      oldString: "const x",
      newString: "const y",
    });
    throw new Error("Should have thrown an error for multiple occurrences");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("found 3 times")) {
      throw new Error(`Expected error about multiple occurrences, got: ${message}`);
    }
    console.log("Correctly threw error:", message);
  }
});

// =============================================================================
// Test 8: editFile with replaceAll
// =============================================================================
await runTest("editFile with replaceAll", async () => {
  sandbox.writeFile(
    "/test-edit-all.ts",
    `const TODO = 'task 1';
const TODO2 = 'task 2';
// TODO: fix this
`
  );
  
  sandbox.editFile("/test-edit-all.ts", {
    oldString: "TODO",
    newString: "DONE",
    replaceAll: true,
  });
  
  const content = sandbox.readFileRaw("/test-edit-all.ts");
  console.log("After replaceAll:");
  console.log(content);
  
  if (content.includes("TODO")) {
    throw new Error("All TODOs should have been replaced");
  }
  if (!content.includes("DONE") || !content.includes("DONE2")) {
    throw new Error("Should contain DONE replacements");
  }
});

// =============================================================================
// Test 9: editFile fails if oldString not found
// =============================================================================
await runTest("editFile fails if oldString not found", async () => {
  sandbox.writeFile("/test-edit-notfound.ts", `const x = 1;`);
  
  try {
    sandbox.editFile("/test-edit-notfound.ts", {
      oldString: "nonexistent string",
      newString: "replacement",
    });
    throw new Error("Should have thrown an error for not found");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("not found")) {
      throw new Error(`Expected 'not found' error, got: ${message}`);
    }
    console.log("Correctly threw error:", message);
  }
});

// =============================================================================
// Test 10: editFile fails if oldString equals newString
// =============================================================================
await runTest("editFile fails if oldString equals newString", async () => {
  sandbox.writeFile("/test-edit-same.ts", `const x = 1;`);
  
  try {
    sandbox.editFile("/test-edit-same.ts", {
      oldString: "const x = 1;",
      newString: "const x = 1;",
    });
    throw new Error("Should have thrown an error for same strings");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("must be different")) {
      throw new Error(`Expected 'must be different' error, got: ${message}`);
    }
    console.log("Correctly threw error:", message);
  }
});

// =============================================================================
// Test 11: editFile with multi-line replacement
// =============================================================================
await runTest("editFile with multi-line replacement", async () => {
  sandbox.writeFile(
    "/test-edit-multiline.ts",
    `function greet() {
  console.log("hello");
}

greet();`
  );
  
  // Replace the function with a new implementation
  sandbox.editFile("/test-edit-multiline.ts", {
    oldString: `function greet() {
  console.log("hello");
}`,
    newString: `function greet(name: string) {
  console.log(\`Hello, \${name}!\`);
  return name;
}`,
  });
  
  const content = sandbox.readFileRaw("/test-edit-multiline.ts");
  console.log("After multi-line edit:");
  console.log(content);
  
  if (!content.includes("name: string")) {
    throw new Error("Should contain new function signature");
  }
  if (!content.includes("return name;")) {
    throw new Error("Should contain new return statement");
  }
});

// =============================================================================
// Test 12: Line number padding for large files
// =============================================================================
await runTest("Line number padding for large files", async () => {
  // Create a 150-line file
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
  sandbox.writeFile("/test-large.ts", lines.join("\n"));
  
  // Read lines around line 100
  const content = sandbox.readFile("/test-large.ts", { offset: 98, limit: 5 });
  console.log("Lines 99-103 from 150-line file:");
  console.log(content);
  
  // Line numbers should be padded correctly (right-aligned)
  // For a 150-line file, we need at least 3 digits, but default padding is 6
  if (!content.includes("  99|line 98")) {
    throw new Error("Line numbers should be right-padded");
  }
});

// =============================================================================
// Test 13: Long line truncation
// =============================================================================
await runTest("Long line truncation at 2000 chars", async () => {
  const longLine = "x".repeat(2500);
  sandbox.writeFile("/test-long-line.ts", longLine);
  
  const content = sandbox.readFile("/test-long-line.ts");
  console.log(`Content length: ${content.length}`);
  console.log(`Ends with '...': ${content.endsWith("...")}`);
  
  // The line should be truncated and end with ...
  if (!content.endsWith("...")) {
    throw new Error("Long lines should be truncated with ...");
  }
  // Should be approximately 2000 + line number prefix + ...
  if (content.length > 2020) {
    throw new Error("Truncated line should be around 2000 chars");
  }
});

// =============================================================================
// Summary
// =============================================================================
console.log("\n" + "=".repeat(60));
console.log("All file operation tests completed!");
console.log("=".repeat(60));

// Clean up
await sandlot.dispose();
