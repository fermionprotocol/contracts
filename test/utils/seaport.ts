import { ethers } from "hardhat";
import { resetCompilationFolder, setCompilationFolder, deriveTokenId } from "./common";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { BigNumberish, Contract } from "ethers";
import { OrderWithCounter } from "@opensea/seaport-js/lib/types";
import { OrderComponents } from "@opensea/seaport-js/lib/types";

const { getContractFactory, getContractAt, parseEther, ZeroAddress, ZeroHash } = ethers;

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
    const buyerAdvancedOrder = await encodeBuyerAdvancedOrder(buyerOrder);

    const encumberedAmount = fullPrice - openSeaFee;

    return { buyerAdvancedOrder, tokenId, encumberedAmount };
  };
}

export async function encodeBuyerAdvancedOrder(
  buyerOrder: OrderWithCounter,
  numerator: bigint = 1n,
  denominator: bigint = 1n,
  extraData: string = "0x",
) {
  const buyerAdvancedOrder = {
    ...buyerOrder,
    numerator,
    denominator,
    extraData,
  };

  const SeaportWrapperInterface = await getContractAt("ABIEncoder", ZeroAddress);
  const data = SeaportWrapperInterface.interface.encodeFunctionData("encodeSeaportAdvancedOrder", [buyerAdvancedOrder]);

  // remove the function signature
  return "0x" + data.slice(10);
}

export function getOrderParametersClosure(seaport: Seaport, seaportConfig: any, wrapperAddress: string) {
  return async function getOrderParameters(
    tokenId: string,
    exchangeToken: string,
    fullPrice: bigint,
    startTime: string,
    endTime: string,
    royalties: { recipients: string[]; bps: bigint[] } = { recipients: [], bps: [] },
    validatorEnabled: boolean = true,
  ) {
    const openSeaFee = (fullPrice * 2_50n) / 100_00n;
    let reducedPrice = fullPrice - openSeaFee;
    const royaltyConsiderations = [];
    for (let i = 0; i < royalties.recipients.length; i++) {
      const royalty = (fullPrice * royalties.bps[i]) / 100_00n;

      const consideration = {
        itemType: ItemType.ERC20,
        token: exchangeToken,
        amount: royalty.toString(),
        recipient: royalties.recipients[i],
      };
      royaltyConsiderations.push(consideration);

      reducedPrice -= royalty;
    }

    const { executeAllActions } = await seaport.createOrder(
      {
        offer: [
          {
            itemType: ItemType.ERC721,
            token: wrapperAddress,
            identifier: tokenId,
          },
        ],
        consideration: [
          {
            itemType: ItemType.ERC20,
            token: exchangeToken,
            amount: reducedPrice.toString(),
          },
          {
            itemType: ItemType.ERC20,
            token: exchangeToken,
            amount: openSeaFee.toString(),
            recipient: seaportConfig.openSeaRecipient,
          },
          ...royaltyConsiderations,
        ],
        conduitKey: seaportConfig.openSeaConduitKey,
        zone: validatorEnabled ? seaportConfig.openSeaSignedZone : ZeroAddress,
        zoneHash: validatorEnabled ? seaportConfig.openSeaZoneHash : ZeroHash,
        startTime,
        endTime,
        salt: "0", // matching the value in seaportWrapper.listFixedPriceOrders
        restrictedByZone: validatorEnabled && seaportConfig.openSeaSignedZone != ZeroAddress,
      },
      wrapperAddress,
    );

    const fixedPriceOrder = await executeAllActions();

    return fixedPriceOrder.parameters;
  };
}

export function getOrderStatusClosure(seaport: Seaport) {
  return async function getOrderStatus(orderComponents: OrderComponents) {
    const orderHash = seaport.getOrderHash(orderComponents);
    const orderStatus = await seaport.getOrderStatus(orderHash);

    return orderStatus;
  };
}

export function getOrderParametersAndStatusClosure(
  getOrderParameters: (
    tokenId: string,
    exchangeToken: string,
    fullPrice: bigint,
    startTime: string,
    endTime: string,
    royalties: { recipients: string[]; bps: bigint[] },
    validatorEnabled: boolean,
  ) => Promise<OrderComponents>,
  getOrderStatus: (order: OrderComponents) => Promise<{ isCancelled: boolean; isValidated: boolean }>,
) {
  return async function getOrderParametersAndStatus(
    tokenId: string,
    exchangeToken: string,
    fullPrice: bigint,
    startTime: string,
    endTime: string,
    royalties: { recipients: string[]; bps: bigint[] } = { recipients: [], bps: [] },
    validatorEnabled: boolean = true,
  ) {
    const orderComponents = await getOrderParameters(
      tokenId,
      exchangeToken,
      fullPrice,
      startTime,
      endTime,
      royalties,
      validatorEnabled,
    );
    const orderStatus = await getOrderStatus(orderComponents);

    return { orderComponents, orderStatus };
  };
}
