import { ethers } from "hardhat";
import { resetCompilationFolder, setCompilationFolder, deriveTokenId } from "./common";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { BigNumberish, Contract } from "ethers";
import { OrderWithCounter } from "@opensea/seaport-js/lib/types";

const { getContractFactory, parseEther } = ethers;

// Deploys WETH, Boson Protocol Diamond, Boson Price Discovery, Boson Voucher Implementation, Boson Voucher Beacon Client
export async function initSeaportFixture() {
  await setSeaportCompilationFolder();

  const conduitControllerFactory = await getContractFactory("ConduitController");
  const conduitController = await conduitControllerFactory.deploy();
  await conduitController.waitForDeployment();

  // Deploy Seaport
  const seaportFactory = await getContractFactory("Seaport");
  const seaport = await seaportFactory.deploy(await conduitController.getAddress());
  await seaport.waitForDeployment();

  await resetCompilationFolder();

  return { seaportAddress: await seaport.getAddress(), seaportContract: seaport };
}

// Set the Seaport contracts compilation folder to the Boson Protocol contracts and compiles them.
// Used to avoid artifacts clashes.
async function setSeaportCompilationFolder() {
  const contracts = [["Seaport.sol"], ["conduit", "*.sol"]];

  return setCompilationFolder("seaport", contracts);
}

export function createBuyerAdvancedOrderClosure(
  wallets: HardhatEthersSigner[],
  seaportAddress: string,
  mockToken: Contract,
  offerFacet: Contract,
) {
  return async function (buyer: HardhatEthersSigner, offerId: string, exchangeId: string | BigNumberish) {
    const fullPrice = parseEther("1");
    const openSeaFee = (fullPrice * 2n) / 100n;
    const openSea = wallets[5]; // a mock OS address
    const seaport = new Seaport(buyer, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

    await mockToken.mint(buyer.address, fullPrice);

    const exchangeToken = await mockToken.getAddress();
    const tokenId = deriveTokenId(offerId, exchangeId).toString();
    const wrapperAddress = await offerFacet.predictFermionFNFTAddress(offerId);
    const { executeAllActions } = await seaport.createOrder(
      {
        offer: [
          {
            itemType: ItemType.ERC20,
            token: exchangeToken,
            amount: fullPrice.toString(),
          },
        ],
        consideration: [
          {
            itemType: ItemType.ERC721,
            token: wrapperAddress,
            identifier: tokenId,
          },
          {
            itemType: ItemType.ERC20,
            token: exchangeToken,
            amount: openSeaFee.toString(),
            recipient: openSea.address,
          },
        ],
      },
      buyer.address,
    );

    const buyerOrder = await executeAllActions();
    const buyerAdvancedOrder = encodeBuyerAdvancedOrder(buyerOrder);

    const encumberedAmount = fullPrice - openSeaFee;

    return { buyerAdvancedOrder, tokenId, encumberedAmount };
  };
}

export function encodeBuyerAdvancedOrder(
  buyerOrder: OrderWithCounter,
  numerator: bigint = 1n,
  denominator: bigint = 1n,
  extraData: string = "0x",
) {
  const abiCoder = new ethers.AbiCoder();
  const advancedOrderTupleType = `tuple(
            tuple(
                address offerer,
                address zone,
                tuple(
                    uint8 itemType,
                    address token,
                    uint256 identifierOrCriteria,
                    uint256 startAmount,
                    uint256 endAmount
                )[] offer,
                tuple(
                    uint8 itemType,
                    address token,
                    uint256 identifierOrCriteria,
                    uint256 startAmount,
                    uint256 endAmount,
                    address recipient
                )[] consideration,
                uint8 orderType,
                uint256 startTime,
                uint256 endTime,
                bytes32 zoneHash,
                uint256 salt,
                bytes32 conduitKey,
                uint256 totalOriginalConsiderationItems
            ) parameters,
            uint120 numerator,
            uint120 denominator,
            bytes signature,
            bytes extraData
        )`;

  const buyerAdvancedOrder = {
    ...buyerOrder,
    numerator,
    denominator,
    extraData,
  };

  return abiCoder.encode([advancedOrderTupleType], [buyerAdvancedOrder]);
}
