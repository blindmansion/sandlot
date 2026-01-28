import { createNodeSandlot } from "sandlot/node";
const sandlot = await createNodeSandlot();
const sandbox = await sandlot.createSandbox();

await sandbox.exec("echo 'Hello via Bun!'");
sandbox.fs.writeFile("hello.ts", "console.log('Hello via Bun!');");
await sandbox.exec("run hello.ts");
console.log((await sandbox.exec("sandlot typecheck hello.ts")).stdout);
console.log((await sandbox.exec("sandlot build hello.ts")).stdout);
console.log((await sandbox.exec("sandlot install nanoid")).stdout);

// write something using nanoid and run it
sandbox.writeFile("hello.ts", "import { nanoid } from 'nanoid'; console.log(nanoid());");
console.log(sandbox.readFile("hello.ts"));
console.log((await sandbox.exec("sandlot typecheck hello.ts")));
console.log((await sandbox.exec("sandlot build hello.ts")));
console.log((await sandbox.exec("sandlot run hello.ts")));