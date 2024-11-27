module.exports = {
  skipFiles: [
    "test",
    "diamond",
    "external",
    "protocol/clients/FermionFractionsERC20Base.sol",
    "protocol/clients/oracle/ChainlinkPriceOracle.sol"
  ],
  modifierWhitelist: ["nonReentrant"],
  istanbulReporter: ["html", "json-summary", "lcov", "text"],
};
