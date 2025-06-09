FROM node:20-alpine3.22
RUN apk update
RUN apk add git

WORKDIR /app

COPY yarn.lock package.json tsconfig.json ./
RUN mkdir -p ./scripts
RUN mkdir -p ./contracts/external

COPY ./scripts/postinstall.ts ./scripts

RUN yarn install

COPY ./*.* ./
COPY ./contracts ./contracts

RUN npx hardhat compile

COPY . .

EXPOSE 8545

CMD ["sh", "./e2e/launch-container.sh"]
