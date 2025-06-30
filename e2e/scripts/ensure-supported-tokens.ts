import * as hre from "hardhat";
import { Contract, TransactionReceipt, TransactionResponse } from "ethers";

export async function ensureTokensAreSupported(fermionProtocolAddress: string, tokenAddresses: string[]) {
  const deployer = (await hre.ethers.getSigners())[0];
  const fermionOfferFacet = new Contract(
    fermionProtocolAddress,
    `[{
      "inputs": [
        {
          "internalType": "address",
          "name": "_tokenAddress",
          "type": "address"
        }
      ],
      "name": "addSupportedToken",
      "outputs": [],
      "stateMutability": "nonpayable",
      "type": "function"
    }]`,
    deployer
  );
  let oldNonce = -1;
  const promises: Promise<TransactionReceipt | null>[] = [];
  for (const tokenAddress of tokenAddresses) {
    try {
      let nonce = await deployer.getNonce();
      while (nonce <= oldNonce) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        nonce = await deployer.getNonce();
      }
      const tx =
        (await fermionOfferFacet.addSupportedToken(tokenAddress, { nonce })) as TransactionResponse;
      promises.push(tx.wait());
      oldNonce = nonce;
    } catch (e) {
      // Allow the transaction to fail, when the exchangeToken is already supported by the DR
      // (0x6c888286 = error DuplicateDisputeResolverFees())
      if (e.reason !== "DuplicateDisputeResolverFees") {
        throw e;
      }
    }
  }
  await Promise.all(promises);
}