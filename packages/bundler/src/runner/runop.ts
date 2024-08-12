// runner script, to create

/**
 * a simple script runner, to test the bundler and API.
 * for a simple target method, we just call the "nonce" method of the account itself.
 */

import { BigNumber, Signer, Wallet } from "ethers";
import { formatEther, keccak256, parseEther } from "ethers/lib/utils";
import { Command } from "commander";
import { erc4337RuntimeVersion } from "@account-abstraction/utils";
import fs from "fs";

import { runBundler } from "../runBundler";
import { BundlerServer } from "../BundlerServer";
import { getNetworkProvider } from "../Config";
import dotenv from "dotenv";
import { ENTRY_POINT } from "./ep";
import { Runner } from "./runner";
dotenv.config();

async function main(): Promise<void> {
	const program = new Command()
		.version(erc4337RuntimeVersion)
		.option("--network <string>", "network name or url", "http://localhost:8545")
		.option(
			"--mnemonic <file>",
			"mnemonic/private-key file of signer account (to fund account). null for .env BUNDLER_SIGNER_PK read"
		)
		.option("--bundlerUrl <url>", "bundler URL", "http://localhost:3000/rpc")
		.option("--entryPoint <string>", "address of the supported EntryPoint contract", ENTRY_POINT)
		.option("--nonce <number>", "account creation nonce. default to random (deploy new account)")
		.option("--deployFactory", 'Deploy the "account deployer" on this network (default for testnet)')
		.option("--show-stack-traces", "Show stack traces.")
		.option("--selfBundler", "run bundler in-process (for debugging the bundler)");

	const opts = program.parse().opts();
	const provider = getNetworkProvider(opts.network);
	let signer: Wallet;
	let deployFactory: boolean = opts.deployFactory;
	let bundler: BundlerServer | undefined;
	if (opts.selfBundler != null) {
		// todo: if node is geth, we need to fund our bundler's account:
		const signer = provider.getSigner();

		const signerBalance = await provider.getBalance(signer.getAddress());
		const account = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
		const bal = await provider.getBalance(account);
		if (bal.lt(parseEther("1")) && signerBalance.gte(parseEther("10000"))) {
			console.log("funding hardhat account", account);
			await signer.sendTransaction({
				to: account,
				value: parseEther("1").sub(bal),
			});
		}

		const argv = ["node", "exec", "--config", "./localconfig/bundler.config.json", "--unsafe", "--auto"];
		if (opts.entryPoint != null) {
			argv.push("--entryPoint", opts.entryPoint);
		}
		bundler = await runBundler(argv);
		await bundler.asyncStart();
	}
	if (opts.mnemonic != null) {
		signer = Wallet.fromMnemonic(fs.readFileSync(opts.mnemonic, "ascii").trim()).connect(provider);
	} else {
		try {
			// signer = Wallet.fromMnemonic(process.env.BUNDLER_SIGNER_MNEMONIC as string).connect(provider);
			signer = new Wallet(process.env.BUNDLER_SIGNER_PK as string).connect(provider);
			console.log(signer);
			const network = await provider.getNetwork();
			if (network.chainId === 1337 || network.chainId === 31337) {
				deployFactory = true;
			}
		} catch (e) {
			throw new Error("must specify --mnemonic");
		}
	}
	const accountOwner = new Wallet("0x".padEnd(66, "7"));

	const index = opts.nonce ?? Date.now();
	console.log("using account index=", index);
	const client = await new Runner(provider, opts.bundlerUrl, accountOwner, opts.entryPoint, index).init(
		deployFactory ? signer : undefined
	);

	const addr = await client.getAddress();

	async function isDeployed(addr: string): Promise<boolean> {
		return await provider.getCode(addr).then((code) => code !== "0x");
	}

	async function getBalance(addr: string): Promise<BigNumber> {
		return await provider.getBalance(addr);
	}

	const bal = await getBalance(addr);
	console.log("account address", addr, "deployed=", await isDeployed(addr), "bal=", formatEther(bal));
	const gasPrice = await provider.getGasPrice();
	// TODO: actual required val
	const requiredBalance = gasPrice.mul(4e6);
	if (bal.lt(requiredBalance.div(2))) {
		console.log("funding account to", requiredBalance.toString());

		await signer
			.sendTransaction({
				to: addr,
				value: requiredBalance.sub(bal),
				gasPrice,
			})
			.then(async (tx) => await tx.wait());
	} else {
		console.log("not funding account. balance is enough");
	}

	const dest = addr;
	const data = keccak256(Buffer.from("entryPoint()")).slice(0, 10);
	console.log("data=", data);
	await client.runUserOp(dest, data);
	console.log("after run1");
	// client.accountApi.overheads!.perUserOp = 30000
	await client.runUserOp(dest, data);
	console.log("after run2");
	await bundler?.stop();
}

void main()
	.catch((e) => {
		console.log(e);
		process.exit(1);
	})
	.then(() => process.exit(0));
