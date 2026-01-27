import { createSandbox } from "sandlot";

const sandbox = await createSandbox();

await sandbox.bash.exec("echo 'Hello via Bun!'");
await sandbox.fs.writeFile("hello.ts", "console.log('Hello via Bun!');");
await sandbox.bash.exec("run hello.ts");
console.log((await sandbox.bash.exec("tsc hello.ts")).stdout);
console.log((await sandbox.bash.exec("build hello.ts")).stdout);
console.log((await sandbox.bash.exec("install nanoid")).stdout);