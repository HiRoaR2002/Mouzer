const { Key } = require("@nut-tree-fork/nut-js");

const names = [];
for (const [k, v] of Object.entries(Key)) if (typeof v === "string") names.push(`${v}=${k}`);

console.log("TOTAL: " + names.length + "\n");
for (let i = 0; i < names.length; i += 6) {
  console.log(names.slice(i, i + 6).map((s) => s.padEnd(24)).join(""));
}
