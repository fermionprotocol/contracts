import { loadFixture, setCode } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployMockTokens } from "../utils/common";
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Contract, MaxUint256 } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TokenState } from "../utils/enums";
import {
  initSeaportFixture,
  getOrderParametersClosure,
  getOrderStatusClosure,
  getOrderParametersAndStatusClosure,
} from "../utils/seaport";
import { Seaport } from "@opensea/seaport-js";
import fermionConfig from "./../../fermion.config";
import { OrderComponents } from "@opensea/seaport-js/lib/types";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

const { ZeroAddress, parseEther } = ethers;

describe("FermionFNFT - wrapper tests", function () {
  let fermionWrapper: Contract, fermionWrapperProxy: Contract;
  let wallets: HardhatEthersSigner[];
  let fermionProtocolSigner: HardhatEthersSigner;
  let wrapperContractOwner: HardhatEthersSigner;
  let mockBosonPriceDiscovery: HardhatEthersSigner;
  let mockBoson: Contract, mockERC20: Contract, mockFermion: Contract;
  let seaportAddress: string;
  let seaport: Seaport;
  const metadataURI = "https://example.com";
  const { seaportConfig } = fermionConfig.externalContracts["hardhat"];

  async function setupFermionWrapperTest() {
    wallets = await ethers.getSigners();
    fermionProtocolSigner = wallets[1]; // wallet that simulates the fermion protocol
    wrapperContractOwner = wallets[2];

    const mockBosonPriceDiscovery = wallets[10];

    ({ seaportAddress } = await initSeaportFixture());

    const seaportWrapperConstructorArgs = [
      mockBosonPriceDiscovery.address,
      {
        ...seaportConfig,
        seaport: seaportAddress,
      },
    ];
    const FermionSeaportWrapper = await ethers.getContractFactory("SeaportWrapper");
    const fermionSeaportWrapper = await FermionSeaportWrapper.deploy(...seaportWrapperConstructorArgs);
    const FermionFNFTPriceManager = await ethers.getContractFactory("FermionFNFTPriceManager");
    const fermionFNFTPriceManager = await FermionFNFTPriceManager.deploy();
    const FermionFractionsMint = await ethers.getContractFactory("FermionFractionsMint");
    const fermionFractionsMint = await FermionFractionsMint.deploy(mockBosonPriceDiscovery.address);
    const FermionBuyoutAuction = await ethers.getContractFactory("FermionBuyoutAuction");
    const fermionBuyoutAuction = await FermionBuyoutAuction.deploy(mockBosonPriceDiscovery.address);

    const FermionFNFT = await ethers.getContractFactory("FermionFNFT");
    const fermionWrapper = await FermionFNFT.deploy(
      mockBosonPriceDiscovery.address,
      await fermionSeaportWrapper.getAddress(),
      wallets[10].address,
      await fermionFractionsMint.getAddress(),
      await fermionFNFTPriceManager.getAddress(),
      await fermionBuyoutAuction.getAddress(),
    ); // dummy address

    const Proxy = await ethers.getContractFactory("MockProxy");
    const proxy = await Proxy.deploy(await fermionWrapper.getAddress());

    const fermionWrapperProxy = await ethers.getContractAt("FermionFNFT", await proxy.getAddress());

    const [mockBoson, mockERC20] = await deployMockTokens(["ERC721", "ERC20"]);

    const mockFermionFactory = await ethers.getContractFactory("MockFermion");
    mockFermion = await mockFermionFactory.deploy(ZeroAddress, ZeroAddress);
    const code = await ethers.provider.getCode(await mockFermion.getAddress());
    mockFermion = mockFermion.attach(await fermionProtocolSigner.getAddress());

    await setCode(await fermionProtocolSigner.getAddress(), code);

    const rando = wallets[9];
    seaport = new Seaport(rando, { overrides: { seaportVersion: "1.6", contractAddress: seaportAddress } });

    return { fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery, mockERC20 };
  }

  before(async function () {
    ({ fermionWrapper, fermionWrapperProxy, mockBoson, mockBosonPriceDiscovery, mockERC20 } =
      await loadFixture(setupFermionWrapperTest));

    fermionWrapperProxy = fermionWrapperProxy.connect(fermionProtocolSigner);
  });

  afterEach(async function () {
    await loadFixture(setupFermionWrapperTest);
  });

  after(async function () {
    // make the account "normal" again
    // `setCode` helper from the toolbox does not accept empty code, so we use the provider directly
    await ethers.provider.send("hardhat_setCode", [await fermionProtocolSigner.getAddress(), "0x"]);
  });

  context("initialize", function () {
    const offerId = 1n;

    it("Initialization via proxy sets the new owner and metadataURI", async function () {
      await expect(
        fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
      )
        .to.emit(fermionWrapperProxy, "OwnershipTransferred")
        .withArgs(ZeroAddress, wrapperContractOwner.address);

      expect(await fermionWrapperProxy.owner()).to.equal(wrapperContractOwner.address);
      expect(await fermionWrapperProxy.contractURI()).to.equal(metadataURI);
    });

    context("Revert reasons", function () {
      it("Direct initialization fails", async function () {
        await expect(
          fermionWrapper.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });

      it("Second initialization via proxy fails", async function () {
        await fermionWrapperProxy.initialize(
          ZeroAddress,
          wrapperContractOwner.address,
          ZeroAddress,
          offerId,
          metadataURI,
        );

        await expect(
          fermionWrapperProxy.initialize(ZeroAddress, wrapperContractOwner.address, ZeroAddress, offerId, metadataURI),
        ).to.be.revertedWithCustomError(fermionWrapper, "InvalidInitialization");
      });
    });
  });

  context("transferOwnership", function () {
    const offerId = 1n;
    beforeEach(async function () {
      await fermionWrapperProxy.initialize(
        ZeroAddress,
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
    });

    it("Initialization caller can transfer the ownership", async function () {
      const newOwner = wallets[3];

      await expect(
        fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("transferOwnership", [newOwner.address]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        }),
      )
        .to.emit(fermionWrapperProxy, "OwnershipTransferred")
        .withArgs(wrapperContractOwner.address, newOwner.address);

      expect(await fermionWrapperProxy.owner()).to.equal(newOwner.address);
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        const newOwner = wallets[3];
        await expect(fermionWrapperProxy.connect(newOwner).transferOwnership(newOwner.address))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "OwnableUnauthorizedAccount")
          .withArgs(newOwner.address);

        await expect(
          newOwner.sendTransaction({
            to: await fermionWrapperProxy.getAddress(),
            data:
              fermionWrapperProxy.interface.encodeFunctionData("transferOwnership", [newOwner.address]) +
              fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
          }),
        )
          .to.be.revertedWithCustomError(fermionWrapperProxy, "OwnableUnauthorizedAccount")
          .withArgs(newOwner.address);
      });

      it("The owner cannot transfer it directly", async function () {
        expect(await fermionWrapperProxy.owner()).to.equal(wrapperContractOwner.address);

        const newOwner = wallets[3];
        await expect(fermionWrapperProxy.connect(wrapperContractOwner).transferOwnership(newOwner.address))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "OwnableUnauthorizedAccount")
          .withArgs(wrapperContractOwner.address);
      });
    });
  });

  context("wrap", function () {
    let seller: HardhatEthersSigner;
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const offerId = 1n;
    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);

      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );

      seller = wallets[3];
    });

    it("Protocol can wrap", async function () {
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      const tx = await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        await expect(tx).to.emit(fermionWrapperProxy, "Transfer").withArgs(ZeroAddress, seller.address, tokenId);
        await expect(tx).to.not.emit(fermionWrapperProxy, "FixedPriceSale");
        expect(await fermionWrapperProxy.ownerOf(tokenId)).to.equal(seller.address);
      }
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        const randomWallet = wallets[4];
        await expect(fermionWrapperProxy.connect(randomWallet).wrap(startTokenId, quantity, seller.address))
          .to.be.revertedWithCustomError(mockBoson, "ERC721InsufficientApproval")
          .withArgs(await fermionWrapperProxy.getAddress(), startTokenId);
      });

      it("Wrapped vouchers cannot be transferred", async function () {
        const newOwner = wallets[4];
        await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, seller.address]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        for (let i = 0n; i < quantity; i++) {
          const tokenId = startTokenId + i;
          await expect(fermionWrapperProxy.connect(seller).transferFrom(seller.address, newOwner.address, tokenId))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(tokenId, seller.address, TokenState.Wrapped);
        }
      });
    });
  });

  context("fixed priced offers", function () {
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const prices = [...Array(Number(quantity)).keys()].map((n) => parseEther((n + 1).toString()));
    const endTimes = Array(Number(quantity)).fill(MaxUint256);
    const offerId = 1n;
    let wrapperAddress: string;

    let getOrderParameters: (
      tokenId: string,
      exchangeToken: string,
      fullPrice: bigint,
      endTime: string,
    ) => Promise<OrderComponents>;
    let getOrderStatus: (order: OrderComponents) => Promise<{ isCancelled: boolean; isValidated: boolean }>;
    let getOrderParametersAndStatus: (
      tokenId: string,
      exchangeToken: string,
      fullPrice: bigint,
      endTime: string,
    ) => Promise<{ orderComponents: OrderComponents; orderStatus: { isCancelled: boolean; isValidated: boolean } }>;

    before(async function () {
      wrapperAddress = await fermionWrapperProxy.getAddress();
      getOrderParameters = getOrderParametersClosure(seaport, seaportConfig, wrapperAddress);
      getOrderStatus = getOrderStatusClosure(seaport);
      getOrderParametersAndStatus = getOrderParametersAndStatusClosure(getOrderParameters, getOrderStatus);
    });

    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity + 1n);

      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );

      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(wrapperAddress, true);
      await fermionProtocolSigner.sendTransaction({
        to: wrapperAddress,
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, wrapperAddress]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });
    });

    context("listFixedPriceOrders", function () {
      it("Protocol can list fixed price offer", async function () {
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("listFixedPriceOrders", [
              startTokenId,
              prices,
              endTimes,
              await mockERC20.getAddress(),
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        const exchangeToken = await mockERC20.getAddress();

        for (let i = 0n; i < quantity; i++) {
          const tokenId = startTokenId + i;
          expect(await fermionWrapperProxy.ownerOf(tokenId)).to.equal(wrapperAddress);

          const { orderStatus } = await getOrderParametersAndStatus(
            tokenId.toString(),
            exchangeToken,
            prices[Number(i)],
            endTimes[Number(i)].toString(),
          );
          expect(orderStatus.isValidated).to.equal(true);
        }
      });

      context("Revert reasons", function () {
        it("Unauthorized call", async function () {
          const randomWallet = wallets[4];
          await expect(
            fermionWrapperProxy
              .connect(randomWallet)
              .listFixedPriceOrders(startTokenId, prices, endTimes, await mockBoson.getAddress()),
          )
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, randomWallet.address, TokenState.Wrapped);
        });

        it("Some of the prices are zero", async function () {
          const zeroPrices = prices.map(() => 0n);
          await expect(
            fermionProtocolSigner.sendTransaction({
              to: await fermionWrapperProxy.getAddress(),
              data:
                fermionWrapperProxy.interface.encodeFunctionData("listFixedPriceOrders", [
                  startTokenId,
                  zeroPrices,
                  endTimes,
                  await mockERC20.getAddress(),
                ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
            }),
          ).to.be.revertedWithCustomError(fermionWrapperProxy, "ZeroPriceNotAllowed");
        });
      });
    });

    context("cancelFixedPriceOrders", function () {
      it("Protocol can cancel fixed price offer", async function () {
        const exchangeToken = await mockERC20.getAddress();
        const orders = await Promise.all(
          prices.map((price, i) => {
            return getOrderParameters(
              (startTokenId + BigInt(i)).toString(),
              exchangeToken,
              price,
              endTimes[i].toString(),
            );
          }),
        );
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("cancelFixedPriceOrders", [orders]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        for (let i = 0; i < quantity; i++) {
          const orderStatus = await getOrderStatus(orders[i]);
          expect(orderStatus.isCancelled).to.equal(true);
        }
      });

      context("Revert reasons", function () {
        it("Unauthorized call", async function () {
          const randomWallet = wallets[4];
          await expect(fermionWrapperProxy.connect(randomWallet).cancelFixedPriceOrders([]))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "AccessDenied")
            .withArgs(randomWallet.address);
        });

        it("Contract is not the owner", async function () {
          const randomWallet = wallets[4];
          const tokenId = (startTokenId + quantity).toString();
          await fermionProtocolSigner.sendTransaction({
            to: wrapperAddress,
            data:
              fermionWrapperProxy.interface.encodeFunctionData("wrap", [tokenId, 1n, randomWallet.address]) +
              fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
          });

          const orders = [
            await getOrderParameters(startTokenId.toString(), await mockERC20.getAddress(), prices[0], endTimes[0]),
          ]; // use startTokenId, so the order generation works and replace it manually
          orders[0].offer[0].identifierOrCriteria = tokenId;

          await expect(
            fermionProtocolSigner.sendTransaction({
              to: await fermionWrapperProxy.getAddress(),
              data:
                fermionWrapperProxy.interface.encodeFunctionData("cancelFixedPriceOrders", [orders]) +
                fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
            }),
          )
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidOwner")
            .withArgs(tokenId, wrapperAddress, randomWallet.address);
        });

        it("Token id does not exist", async function () {
          const tokenId = (startTokenId + quantity + 1n).toString();
          const orders = [
            await getOrderParameters(startTokenId.toString(), await mockERC20.getAddress(), prices[0], endTimes[0]),
          ]; // use startTokenId, so the order generation works and replace it manually
          orders[0].offer[0].identifierOrCriteria = tokenId;

          await expect(
            fermionProtocolSigner.sendTransaction({
              to: await fermionWrapperProxy.getAddress(),
              data:
                fermionWrapperProxy.interface.encodeFunctionData("cancelFixedPriceOrders", [orders]) +
                fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
            }),
          )
            .to.be.revertedWithCustomError(fermionWrapperProxy, "ERC721NonexistentToken")
            .withArgs(tokenId);
        });
      });
    });
  });

  context("unwrap/unwrapToSelf", function () {
    // This tests internal FermionFNFT.unwrap function, which is used by both unwrap and unwrapToSelf
    // Tests are done using only unwrapToSelf, since the setup is simpler

    let seller: HardhatEthersSigner;
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const offerId = 1n;

    beforeEach(async function () {
      seller = wallets[3];

      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
    });

    context("auction-style", function () {
      beforeEach(async function () {
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, seller.address]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });
      });

      it("Boson price discovery can unwrap", async function () {
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        const tx = await fermionWrapperProxy
          .connect(mockBosonPriceDiscovery)
          .unwrapToSelf(startTokenId, ZeroAddress, 0);

        await expect(tx)
          .to.emit(mockBoson, "Transfer")
          .withArgs(await fermionWrapperProxy.getAddress(), fermionProtocolSigner.address, startTokenId);
        await expect(tx).to.not.emit(fermionWrapperProxy, "FixedPriceSale");

        expect(await mockBoson.ownerOf(startTokenId)).to.equal(fermionProtocolSigner.address);
        expect(await fermionWrapperProxy.tokenState(startTokenId)).to.equal(TokenState.Unverified);
      });

      context("Revert reasons", function () {
        it("Unauthorized call", async function () {
          // Fermion protocol
          await expect(fermionWrapperProxy.unwrapToSelf(startTokenId, ZeroAddress, 0))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, fermionProtocolSigner.address, TokenState.Wrapped);

          // Seller
          await expect(fermionWrapperProxy.connect(seller).unwrapToSelf(startTokenId, ZeroAddress, 0))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, seller.address, TokenState.Wrapped);

          // Random wallet
          const randomWallet = wallets[4];
          await expect(fermionWrapperProxy.connect(randomWallet).unwrapToSelf(startTokenId, ZeroAddress, 0))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, randomWallet.address, TokenState.Wrapped);
        });

        it("Only wrapped tokens can be unwrapped", async function () {
          await fermionProtocolSigner.sendTransaction({
            to: await fermionWrapperProxy.getAddress(),
            data:
              fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
                startTokenId,
                TokenState.Unwrapping,
              ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
          });

          await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

          await expect(fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, mockBosonPriceDiscovery.address, TokenState.Unverified);
        });

        it("Unwrapped but unverified FNFTs cannot be transferred", async function () {
          const newOwner = wallets[4];
          await fermionProtocolSigner.sendTransaction({
            to: await fermionWrapperProxy.getAddress(),
            data:
              fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
                startTokenId,
                TokenState.Unwrapping,
              ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
          });

          await fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapToSelf(startTokenId, ZeroAddress, 0);

          await expect(fermionWrapperProxy.connect(seller).transferFrom(seller.address, newOwner.address, startTokenId))
            .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
            .withArgs(startTokenId, seller.address, TokenState.Unverified);
        });
      });
    });

    context("unwrapToSelf in combination with fixed-priced order", function () {
      const prices = [...Array(Number(quantity)).keys()].map((n) => parseEther((n + 1).toString()));
      const endTimes = Array(Number(quantity)).fill(MaxUint256);
      let wrapperAddress: string;

      beforeEach(async function () {
        wrapperAddress = await fermionWrapperProxy.getAddress();

        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, wrapperAddress]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("listFixedPriceOrders", [
              startTokenId,
              prices,
              endTimes,
              await mockERC20.getAddress(),
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });
      });

      it("It's possible to unwrap to self", async function () {
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        const tx = await fermionWrapperProxy
          .connect(mockBosonPriceDiscovery)
          .unwrapToSelf(startTokenId, await mockERC20.getAddress(), 0);

        await expect(tx)
          .to.emit(mockBoson, "Transfer")
          .withArgs(await fermionWrapperProxy.getAddress(), fermionProtocolSigner.address, startTokenId);
        await expect(tx).to.not.emit(fermionWrapperProxy, "FixedPriceSale");

        expect(await mockBoson.ownerOf(startTokenId)).to.equal(fermionProtocolSigner.address);
        expect(await fermionWrapperProxy.tokenState(startTokenId)).to.equal(TokenState.Unverified);
      });

      it("It's possible to unwrap to self if the fixed-price order is cancelled", async function () {
        const getOrderParameters = getOrderParametersClosure(seaport, seaportConfig, wrapperAddress);
        const orders = [
          await getOrderParameters(startTokenId.toString(), await mockERC20.getAddress(), prices[0], endTimes[0]),
        ];

        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("cancelFixedPriceOrders", [orders]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        const tx = await fermionWrapperProxy
          .connect(mockBosonPriceDiscovery)
          .unwrapToSelf(startTokenId, await mockERC20.getAddress(), 0);

        await expect(tx)
          .to.emit(mockBoson, "Transfer")
          .withArgs(await fermionWrapperProxy.getAddress(), fermionProtocolSigner.address, startTokenId);
        await expect(tx).to.not.emit(fermionWrapperProxy, "FixedPriceSale");

        expect(await mockBoson.ownerOf(startTokenId)).to.equal(fermionProtocolSigner.address);
        expect(await fermionWrapperProxy.tokenState(startTokenId)).to.equal(TokenState.Unverified);
      });
    });
  });

  context("unwrapFixedPriced", function () {
    let seller: HardhatEthersSigner;
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const prices = [...Array(Number(quantity)).keys()].map((n) => parseEther((n + 1).toString()));
    const endTimes = Array(Number(quantity)).fill(MaxUint256);
    const offerId = 1n;
    let wrapperAddress: string, buyerAddress: string;
    let buyTx: ethers.ContractTransaction;

    beforeEach(async function () {
      seller = wallets[3];
      wrapperAddress = await fermionWrapperProxy.getAddress();

      seaportAddress = await seaport.contract.getAddress();
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [seaportAddress],
      });

      const seaportSigner = await ethers.getSigner(seaportAddress);

      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);
      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);

      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, wrapperAddress]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("listFixedPriceOrders", [
            startTokenId,
            prices,
            endTimes,
            await mockERC20.getAddress(),
          ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      await mockERC20.mint(wrapperAddress, prices[1]);

      buyerAddress = wallets[4].address;
      buyTx = await fermionWrapperProxy
        .connect(seaportSigner)
        .transferFrom(wrapperAddress, buyerAddress, startTokenId, { gasPrice: 0 });
    });

    it("Buy transaction emits FixedPriceSale event", async function () {
      await expect(buyTx).to.emit(fermionWrapperProxy, "FixedPriceSale").withArgs(startTokenId);
    });

    it("Fermion protocol can unwrap - non zero price", async function () {
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
            startTokenId,
            TokenState.Unwrapping,
          ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      const balanceBefore = await mockERC20.balanceOf(fermionProtocolSigner.address);
      const wrapperBalanceBefore = await mockERC20.balanceOf(wrapperAddress);
      const bosonPriceDiscoveryBalance = await mockERC20.balanceOf(mockBosonPriceDiscovery.address);
      const priceSubOSFee = prices[0] - (prices[0] * 50n) / 10_000n;

      const tx = await fermionWrapperProxy
        .connect(mockBosonPriceDiscovery)
        .unwrapFixedPriced(startTokenId, await mockERC20.getAddress());

      await expect(tx)
        .to.emit(mockBoson, "Transfer")
        .withArgs(await fermionWrapperProxy.getAddress(), fermionProtocolSigner.address, startTokenId);
      await expect(tx)
        .to.emit(mockERC20, "Transfer")
        .withArgs(wrapperAddress, mockBosonPriceDiscovery.address, priceSubOSFee);

      expect(await mockBoson.ownerOf(startTokenId)).to.equal(fermionProtocolSigner.address);
      expect(await fermionWrapperProxy.tokenState(startTokenId)).to.equal(TokenState.Unverified);

      expect(await mockERC20.balanceOf(fermionProtocolSigner.address)).to.equal(balanceBefore);
      expect(await mockERC20.balanceOf(mockBosonPriceDiscovery.address)).to.equal(
        bosonPriceDiscoveryBalance + BigInt(priceSubOSFee),
      );
      expect(await mockERC20.balanceOf(wrapperAddress)).to.equal(wrapperBalanceBefore - BigInt(priceSubOSFee));
    });

    context("Revert reasons", function () {
      it("Unauthorized call", async function () {
        // Fermion protocol
        await expect(fermionWrapperProxy.unwrapFixedPriced(startTokenId, ZeroAddress))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, fermionProtocolSigner.address, TokenState.Wrapped);

        // Seller
        await expect(fermionWrapperProxy.connect(seller).unwrapFixedPriced(startTokenId, ZeroAddress))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, seller.address, TokenState.Wrapped);

        // Random wallet
        const randomWallet = wallets[4];
        await expect(fermionWrapperProxy.connect(randomWallet).unwrapFixedPriced(startTokenId, ZeroAddress))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, randomWallet.address, TokenState.Wrapped);
      });

      it("Only wrapped tokens can be unwrapped", async function () {
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionWrapperProxy
          .connect(mockBosonPriceDiscovery)
          .unwrapFixedPriced(startTokenId, await mockERC20.getAddress());

        await expect(
          fermionWrapperProxy
            .connect(mockBosonPriceDiscovery)
            .unwrapFixedPriced(startTokenId, await mockERC20.getAddress()),
        )
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, mockBosonPriceDiscovery.address, TokenState.Unverified);
      });

      it("Unwrapped but unverified FNFTs cannot be transferred", async function () {
        const newOwner = wallets[4];
        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [
              startTokenId,
              TokenState.Unwrapping,
            ]) + fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionWrapperProxy
          .connect(mockBosonPriceDiscovery)
          .unwrapFixedPriced(startTokenId, await mockERC20.getAddress());

        await expect(fermionWrapperProxy.connect(seller).transferFrom(seller.address, newOwner.address, startTokenId))
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidStateOrCaller")
          .withArgs(startTokenId, seller.address, TokenState.Unverified);
      });

      it("FNFTs cannot be unwrapped using `unwrapFixedPriced` after the item cancelled", async function () {
        const tokenId = startTokenId + 1n;
        // wrapperAddress = await fermionWrapperProxy.getAddress();
        const getOrderParameters = getOrderParametersClosure(seaport, seaportConfig, wrapperAddress);
        const orders = [
          await getOrderParameters(tokenId.toString(), await mockERC20.getAddress(), prices[0], endTimes[0]),
        ];

        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("cancelFixedPriceOrders", [orders]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await fermionProtocolSigner.sendTransaction({
          to: await fermionWrapperProxy.getAddress(),
          data:
            fermionWrapperProxy.interface.encodeFunctionData("pushToNextTokenState", [tokenId, TokenState.Unwrapping]) +
            fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
        });

        await expect(
          fermionWrapperProxy.connect(mockBosonPriceDiscovery).unwrapFixedPriced(tokenId, await mockERC20.getAddress()),
        )
          .to.be.revertedWithCustomError(fermionWrapperProxy, "InvalidOwner")
          .withArgs(tokenId, anyValue, wrapperAddress);
      });
    });
  });

  context("tokenURI", function () {
    const startTokenId = 2n ** 128n + 1n;
    const quantity = 10n;
    const offerId = 1n;

    beforeEach(async function () {
      await mockBoson.mint(fermionProtocolSigner, startTokenId, quantity);

      await fermionWrapperProxy.initialize(
        await mockBoson.getAddress(),
        wrapperContractOwner.address,
        ZeroAddress,
        offerId,
        metadataURI,
      );
    });

    it("All tokens have the same URI", async function () {
      const seller = wallets[3];
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        expect(await fermionWrapperProxy.tokenURI(tokenId)).to.equal(metadataURI);
      }
    });

    it("Some tokens have revised URI", async function () {
      const seller = wallets[3];
      const revisedMetadataURI = "https://revised.com";
      await mockBoson.connect(fermionProtocolSigner).setApprovalForAll(await fermionWrapperProxy.getAddress(), true);
      await fermionProtocolSigner.sendTransaction({
        to: await fermionWrapperProxy.getAddress(),
        data:
          fermionWrapperProxy.interface.encodeFunctionData("wrap", [startTokenId, quantity, seller.address]) +
          fermionProtocolSigner.address.slice(2), // append the address to mimic the fermion protocol behavior
      });

      for (let i = 0n; i < quantity; i = i + 2n) {
        const tokenId = startTokenId + i;
        await mockFermion.setRevisedMetadata(tokenId, `${revisedMetadataURI}${i}`);
      }

      for (let i = 0n; i < quantity; i++) {
        const tokenId = startTokenId + i;
        if (i % 2n == 0n) {
          expect(await fermionWrapperProxy.tokenURI(tokenId)).to.equal(`${revisedMetadataURI}${i}`);
        } else {
          expect(await fermionWrapperProxy.tokenURI(tokenId)).to.equal(metadataURI);
        }
      }
    });

    context("Revert reasons", function () {
      it("Minted, but not wrapped", async function () {
        for (let i = 0n; i < quantity; i++) {
          const tokenId = startTokenId + i;
          await expect(fermionWrapperProxy.tokenURI(tokenId))
            .to.be.revertedWithCustomError(fermionWrapper, "ERC721NonexistentToken")
            .withArgs(tokenId);
        }
      });

      it("Non existent", async function () {
        let tokenId = 0n;
        await expect(fermionWrapperProxy.tokenURI(tokenId))
          .to.be.revertedWithCustomError(fermionWrapper, "ERC721NonexistentToken")
          .withArgs(tokenId);

        tokenId = startTokenId + quantity;
        await expect(fermionWrapperProxy.tokenURI(tokenId)).to.be.revertedWithCustomError(
          fermionWrapper,
          "ERC721NonexistentToken",
        );
      });
    });
  });
});
