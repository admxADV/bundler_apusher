import "@nomicfoundation/hardhat-toolbox";
import "@nomiclabs/hardhat-ethers";
import dotenv from "dotenv";
import "hardhat-deploy";
dotenv.config();

import fs from "fs";

import { HardhatUserConfig } from "hardhat/config";
import { NetworkUserConfig } from "hardhat/src/types/config";

const mnemonicFileName = process.env.MNEMONIC_FILE;
let mnemonic = "test ".repeat(11) + "junk";
if (mnemonicFileName != null && fs.existsSync(mnemonicFileName)) {
	mnemonic = fs.readFileSync(mnemonicFileName, "ascii").trim();
}

function getNetwork(url: string): NetworkUserConfig {
	return {
		url,
		accounts: {
			mnemonic,
		},
	};
}
const RPC_NODE_BASE_URL = "https://boldest-blissful-vineyard.bsc-testnet.quiknode.pro/";

const config: HardhatUserConfig = {
	typechain: {
		outDir: "src/types",
		target: "ethers-v5",
	},
	networks: {
		localhost: {
			url: "http://localhost:8545/",
			saveDeployments: false,
		},
		custom: getNetwork(process.env.RPC_ENDPOINT as string),
	},
	solidity: {
		version: "0.8.23",
		settings: {
			evmVersion: "paris",
			optimizer: { enabled: true },
		},
	},
};

export default config;
