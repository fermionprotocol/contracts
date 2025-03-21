import { prepareFeeBackfillData, prepareOfferBackfillData } from "./upgrade-hooks/1.1.0";

// TODO: DELETE THIS FILE BEFORE MERGING THE PR
(async () => {
  try {
    console.log("Testing backfill data preparation...");
    console.log("\n=== Fee Data ===");
    await prepareFeeBackfillData();

    console.log("\n=== Offer Data ===");
    await prepareOfferBackfillData();
  } catch (error) {
    console.error("Error preparing backfill data:", error);
  }
})();
