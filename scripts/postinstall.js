/* eslint-disable @typescript-eslint/no-var-requires */
const { symlinkSync, existsSync, rmSync, mkdirSync } = require("fs");
const { resolve } = require("path");

const createLink = async (linkPath, target) => {
  while (existsSync(linkPath)) {
    // remove linkPath first
    rmSync(linkPath, { recursive: true });
    await new Promise((r) => setTimeout(r, 200));
  }
  const parentDir = resolve(linkPath, "..");
  if (!existsSync(parentDir)) {
    console.log(`Create parent dir ${parentDir}`);
    mkdirSync(parentDir);
  }
  console.log(`Create link ${linkPath} --> ${target}`);
  symlinkSync(target, linkPath, "junction");
};

const protocol = {
  target: `${resolve(
    __dirname,
    "..",
    "node_modules",
    "@bosonprotocol/boson-protocol-contracts/contracts",
  )}`,
  linkPath: `${resolve(__dirname, "..", "contracts/external/boson-protocol-contracts")}`,
};

async function main() {
  await createLink(protocol.linkPath, protocol.target);
}

main()
  .then(() => console.log("success"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
