import { ethers } from "hardhat";

async function main() {
  const MockForwarder = await ethers.getContractFactory("MockForwarder");
  const forwarder = await MockForwarder.deploy();
  process.env.FORWARDER_ADDRESS = await forwarder.getAddress();
  console.log(
    "deployed forwarder",
    "process.env.FORWARDER_ADDRESS",
    process.env.FORWARDER_ADDRESS
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
