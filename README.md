# EIP4337 reference modules

## Bundler

A basic eip4337 "bundler"

This is a reference implementation for a bundler, implementing the full EIP-4337
RPC calls (both production and debug calls), required to pass the [bundler-spec-tests](https://github.com/eth-infinitism/bundler-spec-tests) test suite.

### Running local node

In order to implement the full spec storage access rules and opcode banning, it must run
against a GETH node, which supports debug_traceCall with javascript "tracer"
Specifically, `hardhat node` and `ganache` do NOT support this API.
You can still run the bundler with such nodes, but with `--unsafe` so it would skip these security checks

If you don't have geth installed locally, you can use docker to run it:

```
docker run --rm -ti --name geth -p 8545:8545 ethereum/client-go:v1.13.5 \
  --miner.gaslimit 12000000 \
  --http --http.api personal,eth,net,web3,debug \
  --http.vhosts '*,localhost,host.docker.internal' --http.addr "0.0.0.0" \
  --allow-insecure-unlock --rpc.allow-unprotected-txs \
  --dev \
  --verbosity 2 \
  --nodiscover --maxpeers 0 --mine \
  --networkid 1337
```

### Usage:

1. run `yarn && yarn preprocess`
2. create `.env` file in ./packages/bundler and fill in `BSC_RPC_API_KEY` and `BUNDLER_SIGNER_PK` fields
3. run `yarn run bundler --auto`

Now your bundler is active on local url http://localhost:3000/rpc
