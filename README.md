<div align="center">
  <img src="/docs/images/banner.png">

<h1 align="center">Fermion Protocol</h1>
</div>

[![Coverage Status](https://coveralls.io/repos/github/fermionprotocol/contracts/badge.svg?branch=main)](https://coveralls.io/github/fermionprotocol/contracts?branch=main)
[![Contracts CI](https://github.com/fermionprotocol/contracts/actions/workflows/ci.yaml/badge.svg)](https://github.com/fermionprotocol/contracts/actions/workflows/ci.yaml)

# Overview

[Fermion Protocol](https://fermionprotocol.io) is a verification protocol built on top of [Boson Protocol](https://www.bosonprotocol.io/). This repository contains all core smart contracts and deployment scripts.

Documentation is available at [docs.fermionprotocol.io](https://docs.fermionprotocol.io/).

## Getting started

### Prerequisites

For local development of the contracts, your development machine will need a few tools installed.

You'll need:

Node (20.12.x)
yarn (1.22.x)

### Install dependencies

```shell
yarn
```

### Quick actions

**Build contracts**

```shell
yarn build
```

**Run unit tests**

```shell
npx hardhat test
```

**Run coverage**

```shell
yarn coverage
```

**Lint and prettify contracts and scripts**

```shell
yarn tidy:contracts
yarn tidy:scripts
```

## Local development

The core protocol contracts are in `contracts/protocol`. They implement the core connection to Boson Protocol, verification, fractionalisation and custody mechanism. Change them if you want to modify core protocol functionalities.

Other supporting contracts are in `contracts/diamond`, `contracts/external` and `contracts/test` and you normally don't change them.

Unit tests are separated by facet and available in `./test`. All contracts are extensively tested. 100% coverage is one of the requirements for code to be included in the main branch.

We advise you to fork the repository before making any local changes. If you want your changes to be added to this repository, refer to [Contributing](#contributing) for details.

### Testing

To test the contract run

```shell
npx hardhat test
```

By default, the gas reporter is disabled. To get the gas report, run the tests with the following command

```shell
REPORT_GAS=true npx hardhat test
```

To get the coverage report, run

```shell
yarn coverage
```

Coverage report formats are "html", "json-summary", "lcov", "text" and the reports get written in `./coverage/`.

#### Integration test

In addition to unit tests, we provide integration tests, found in `./test/integration`. We use the integration tests to ensure compatibility with already deployed contracts.

Currently, we provide the integration tests for:

- seaport contracts on ethereum and polygon.

To run the integration test, you need to set up the RPC endpoints for the network on which you are running the tests. The commands are

```shell
npx hardhat vars set RPC_PROVIDER_POLYGON
npx hardhat vars set RPC_PROVIDER_ETHEREUM
npx hardhat vars set RPC_PROVIDER_BASE
npx hardhat vars set RPC_PROVIDER_OPTIMISM
```

The tests are run on a forked version of the network, so no transactions are submitted to the real networks and no real ethers are spent to cover the gas costs.

To run the test call

```shell
npx hardhat test <testFile> --network <network>
```

- `testFile`: path to test file
- `network`: the network to run the test on. The network must be defined in `./hardhat.config.ts` and must have corresponding Seaport parameters in `./fermion.config.ts`

For example, to run seaport integration test on ethereum, call `npx hardhat test ./test/integration/seaport.ts --network mainnet`

NB: Normal tests and coverage reports skip integration reports.

## Deployment

To deploy the Fermion protocol on a public blockchain:

- set the protocol parameters in `./fermion.config.ts`
- set the deployment configuration variables. The project uses [Hardhat configuration variables](https://hardhat.org/hardhat-runner/docs/guides/configuration-variables)

  Get the list of possible configuration variables.

  ```shell
  npx hardhat vars setup
  ```

  Set the values for the desired network. For example, to set the deployer key and RPC endpoint for polygon amoy, run

  ```shell
  npx hardhat vars set RPC_PROVIDER_AMOY
  npx hardhat vars set DEPLOYER_KEY_AMOY
  ```

  Note: `RPC_PROVIDER_AMOY` and `DEPLOYER_KEY_AMOY` are NOT the values. Run the commands exactly as they are written and Hardhat will prompt you to enter the value.

- Deploy the suite by calling

  ```shell
  npx hardhat deploy-suite --network <network> --env <environment> --modules <modules> [--dry-run] [--create3]
  ```

  - `network`: the network to deploy to. The Network must be defined in `./hardhat.config.ts` and must have corresponding Seaport parameters set in `./fermion.config.ts`
  - `environment`: an optional name for the environment to deploy to. Useful to manage multiple instances on the same network. Value can be anything, typical values are `test`, `staging` and `production`.
  - `modules`: the deployment script is modular and can be deployed step by step. Possible values are `fnft`, `diamond`, `facets`, `initialize` and their combinations.
  - `dry-run`: an optional flag, used to simulate the deployment. If added, the script forks the network and simulates the transactions locally and doesn't submit them to the real network. It is used to test the deployment or upgrade scripts. It also provides an estimate of the cost.
  - `create3`: an optional flag to make a create3 deployment. The deployment address does not depend on the deployer's nonce or contract's bytecode anymore.

- The deployment info is printed into the terminal and JSON with addresses is stored in `addresses/{chainId}-{network}-{environment}.json`

## Contract verification on block explorers

Once the contracts are deployed to public networks, their source code is not public automatically. If you want to enable that users interact with the contracts directly on block explorers (e.g. etherscan) or the Louper, you must verify them.

First, obtain the block explorers API keys and set them in Hardhat configuration variables. You need to set them only for the block explorers on which you intend to verify the contracts.

```shell
npx hardhat vars set POLYGONSCAN_API_KEY
npx hardhat vars set ETHERSCAN_API_KEY
npx hardhat vars set BASESCAN_API_KEY
npx hardhat vars set OPTIMISTIC_ETHERSCAN_API_KEY
```

Verify the contracts by calling

```shell
  npx hardhat verify-suite --network <network> --env <environment> --contracts <contracts>
```

- `network`: the network to verify the contracts on. The Network must be defined in `./hardhat.config.ts` and must have corresponding Seaport parameters set in `./fermion.config.ts`
- `environment`: an optional name for the environment to deploy to. Useful to manage multiple instances on the same network. Value can be anything, typical values are `test`, `staging` and `production`.
- `contracts`: an optional comma-separated list of contracts to verify. If not provided, all contracts will be verified.

Note: if the contracts were deployed in the past and new commits were added to the branch, the verification might fail. In this case, the recommended approach is to checkout the commit at which the contracts were deployed and run the verification.

## Contributing

We welcome contributions! Until now, Fermion Protocol has been largely worked on by a small dedicated team. However, the ultimate goal is for all of the Boson Protocol repositories to be fully owned by the community and contributors. Issues, pull requests, suggestions, and any sort of involvement are more than welcome.

Questions and feedback are always welcome, we will use them to improve our offering.

To contribute your code, first fork the protocol, make local changes in the forked repository and then open a PR from the forked repository to this repository

All PRs must pass all tests before being merged.

By being in this community, you agree to the [Code of Conduct](/code-of-conduct.md). Take a look at it, if you haven't already.

## License

Licensed under [GPL-v3](LICENSE).

## Audit reports

All minor versions of the protocol are thoroughly audited before they are released. Find the information about the audits in the table below.

| version | auditor  |        date        |                                                                                          report                                                                                           |
| :------ | :------: | :----------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| v1.0.0  | Omniscia |  August 6th 2024   | [online](https://omniscia.io/reports/fermion-protocol-boson-rwa-sale-verification-protocol-668e6fc0256870001841b971) \| [PDF](./audits/Omniscia_Audit_Report_Fermion_Protocol_v1.0.0.pdf) |
| v1.0.0  | Omniscia | September 2nd 2024 |            [online](https://omniscia.io/reports/fermion-protocol-second-round-66cd13683575bd00188d023d) \| [PDF](./audits/Omniscia_Audit_Report_Fermion_Protocol_v1.0.0_2.pdf)            |
