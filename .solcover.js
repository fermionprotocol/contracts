module.exports = {
  skipFiles: [
    "test",
    "diamond",
    "external",
    "protocol/clients/FermionFractionsERC20Base.sol",
  ],
  istanbulReporter: ["html", "json-summary", "lcov", "text"],
};
