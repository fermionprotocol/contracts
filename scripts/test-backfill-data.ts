import { prepareBackfillData } from "./upgrade-hooks/1.1.0";

(async () => {
  try {
    console.log("Testing backfill data preparation...");
    await prepareBackfillData();
  } catch (error) {
    console.error("Error preparing backfill data:", error);
  }
})();
