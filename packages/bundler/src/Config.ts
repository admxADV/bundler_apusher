import dotenv from "dotenv";
import fs from "fs";
import ow from "ow";
dotenv.config();

import { JsonRpcProvider } from "@ethersproject/providers";
import { Signer, Wallet } from "ethers";
import { BundlerConfig, bundlerConfigDefault, BundlerConfigShape } from "./BundlerConfig";

function getCommandLineParams(programOpts: any): Partial<BundlerConfig> {
	const params: any = {};
	for (const bundlerConfigShapeKey in BundlerConfigShape) {
		const optionValue = programOpts[bundlerConfigShapeKey];
		if (optionValue != null) {
			params[bundlerConfigShapeKey] = optionValue;
		}
	}
	return params as BundlerConfig;
}

function mergeConfigs(...sources: Array<Partial<BundlerConfig>>): BundlerConfig {
	const mergedConfig = Object.assign({}, ...sources);
	ow(mergedConfig, ow.object.exactShape(BundlerConfigShape));
	return mergedConfig;
}

const DEFAULT_INFURA_ID = "d442d82a1ab34327a7126a578428dfc4";

export function getNetworkProvider(url: string): JsonRpcProvider {
	if (url.match(/^[\w-]+$/) != null) {
		const infuraId = process.env.INFURA_ID1 ?? DEFAULT_INFURA_ID;
		url = `https://${url}.infura.io/v3/${infuraId}`;
	}
	console.log("url=", process.env.RPC_ENDPOINT);
	return new JsonRpcProvider(process.env.RPC_ENDPOINT);
}

export async function resolveConfiguration(
	programOpts: any
): Promise<{ config: BundlerConfig; provider: JsonRpcProvider; wallet: Signer }> {
	const commandLineParams = getCommandLineParams(programOpts);
	let fileConfig: Partial<BundlerConfig> = {};
	const configFileName = programOpts.config;
	if (fs.existsSync(configFileName)) {
		fileConfig = JSON.parse(fs.readFileSync(configFileName, "ascii"));
	}
	const config = mergeConfigs(bundlerConfigDefault, fileConfig, commandLineParams);
	console.log("Merged configuration:", JSON.stringify(config));

	if (config.network === "hardhat") {
		// eslint-disable-next-line
		const provider: JsonRpcProvider = require("hardhat").ethers.provider;
		return { config, provider, wallet: provider.getSigner() };
	}

	const provider = getNetworkProvider(config.network);
	let mnemonic: string;
	let wallet: Wallet;
	try {
		// mnemonic = process.env.BUNDLER_SIGNER_MNEMONIC as string;
		// wallet = Wallet.fromMnemonic(mnemonic).connect(provider);
		wallet = new Wallet(process.env.BUNDLER_SIGNER_PK as string).connect(provider);
	} catch (e: any) {
		throw new Error(`Unable to read --mnemonic ${config.mnemonic}: ${e.message as string}`);
	}
	return { config, provider, wallet };
}
