const nut = require("@nut-tree-fork/nut-js");
const names = Object.keys(nut).sort();
console.log("count:", names.length);
for (let i = 0; i < names.length; i += 8) {
  console.log(names.slice(i, i + 8).map((s) => s.padEnd(16)).join(""));
}
console.log("\nhas Region:", "Region" in nut);
console.log("nut-js version:", require("@nut-tree-fork/nut-js/package.json").version);
