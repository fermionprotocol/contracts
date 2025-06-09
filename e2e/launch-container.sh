#!/bin/bash
# Launcher script allowing to run 2 processes in parallel when the
# container starts
# Ref: https://docs.docker.com/engine/containers/multi-service_container

# turn on bash's job control
set -m

# Repeat the postInstall to restore the correct links
rm /app/contracts/external/boson-protocol-contracts
rm /app/contracts/external/seaport
yarn run postinstall

# Start the blockchain process and put it in the background
npx hardhat node &

# Start the deployment process
npx hardhat run ./e2e/deploy.ts --network localhost

# now we bring the primary process back into the foreground
# and leave it there
fg %1
