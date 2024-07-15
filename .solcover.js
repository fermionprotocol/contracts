module.exports = {
  skipFiles: [
    "test",
    "diamond",
    "external",
    "protocol/clients/FermionFractionsERC20Base.sol",
  ],
  modifierWhitelist: ["nonReentrant"],
  istanbulReporter: ["html", "json-summary", "lcov", "text"],
};
