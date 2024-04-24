import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { initBosonProtocolFixture } from "../utils/boson-protocol";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployDiamond, deployFacets, prepareFacetCuts, makeDiamondCut } from "../../scripts/deploy";

describe("Entity", function () {
  let initializationFacet;
  let wallets, defaultSigner;
  // let fermionErrors;

  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  // ToDo: move into shared fixtures
  async function deployFermionProtocolFixture() {
    const {bosonProtocolAddress} = await initBosonProtocolFixture();

    const diamondAddress = await deployDiamond();
    const facetNames = ["InitializationFacet"];
    const facets = await deployFacets(facetNames);

    const initializationFacet = facets["InitializationFacet"];
    const initializeBosonSeller = initializationFacet.interface.encodeFunctionData("initializeBosonSellerAndBuyer", [bosonProtocolAddress]);

    await makeDiamondCut(
      diamondAddress,
      await prepareFacetCuts(Object.values(facets)),
      await initializationFacet.getAddress(),
      initializeBosonSeller,
    );

    return { diamondAddress, initializationFacet: facets["InitializationFacet"] };
  }

  before(async function () {
    wallets = await ethers.getSigners();
    defaultSigner = wallets[1];

    const { diamondAddress, initializationFacet: inf } = await loadFixture(deployFermionProtocolFixture);
    initializationFacet = inf.connect(defaultSigner).attach(diamondAddress);
    fermionErrors = await ethers.getContractAt("FermionErrors", diamondAddress);
  });

  afterEach(async function () {
    await loadFixture(deployFermionProtocolFixture);
  });

  describe("Initialization facet", function () {
    context("Initial deployment", function () {
      it.only("Check Boson Roles", async function () {
        expect(true).to.be.true;
      });

      context("Revert reasons", function () {
        it.skip("An entity already exists", async function () {

        });
      });
    });
  });
});
