FROM node:20-alpine3.22
RUN apk update
RUN apk add git supervisor

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

COPY ./e2e/supervisord.conf /etc/supervisord.conf

EXPOSE 8545

ENV SUPERVISOR_LOG_LEVEL debug

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
