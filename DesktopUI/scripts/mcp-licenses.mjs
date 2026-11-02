import fs from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const sections = [
  "Production JavaScript dependencies (including the toolbox MCP bridge).\nVersions are pinned in DesktopUI/package-lock.json.\n",
];
const bundledLicense = {
  "prismarine-nbt": "../licenses/prismarine-nbt-MIT.txt",
  "protodef-validator": "../licenses/protodef-validator-MIT.txt",
  punycode: "../licenses/punycode-MIT.txt",
};
for (const [directory, item] of Object.entries(lock.packages)) {
  if (!directory || item.dev || item.optional) continue;
  const info = JSON.parse(
    await fs.readFile(path.join(directory, "package.json"), "utf8"),
  );
  const names = (await fs.readdir(directory)).filter((n) =>
    /^(licen[sc]e|copying|notice)(\.|$)/i.test(n),
  );
  if (!names.length && !bundledLicense[info.name])
    throw Error("Missing license text: " + directory);
  sections.push(
    `\n${"=".repeat(72)}\n${info.name} ${info.version}\nLicense: ${info.license || item.license}\n`,
  );
  if (names.length) {
    for (const name of names)
      if ((await fs.stat(path.join(directory, name))).isFile())
        sections.push(`${name}\n${await fs.readFile(path.join(directory, name), "utf8")}\n`);
  } else {
    sections.push(`${path.basename(bundledLicense[info.name])}\n${await fs.readFile(bundledLicense[info.name], "utf8")}\n`);
  }
}
await fs.writeFile(
  "../licenses/JavaScript-dependencies-NOTICES.txt",
  sections.join("\n"),
  "utf8",
);
console.log("Saved production dependency licenses");
