#!/bin/bash
rm deploy.done

# Repeat the postInstall to restore the correct links
rm /app/contracts/external/boson-protocol-contracts
rm /app/contracts/external/seaport
yarn run postinstall

# Start the deployment process
npx hardhat run ./e2e/scripts/deploy.ts --network localhost
npx hardhat run ./e2e/scripts/deploy-others.ts --network localhost --config ./e2e/hardhat.config-others.ts

touch deploy.done