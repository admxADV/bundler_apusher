import fs from "fs";

import {
	deployEntryPoint,
	erc4337RuntimeVersion,
	IEntryPoint,
	RpcError,
	supportsRpcMethod,
} from "@account-abstraction/utils";
import { Command } from "commander";
import { ethers, Signer, Wallet } from "ethers";

import { BundlerServer } from "./BundlerServer";
import { MethodHandlerERC4337 } from "./MethodHandlerERC4337";

import { supportsDebugTraceCall } from "@account-abstraction/validation-manager";
import { JsonRpcProvider } from "@ethersproject/providers";
import { parseEther } from "ethers/lib/utils";
import { bundlerConfigDefault } from "./BundlerConfig";
import { resolveConfiguration } from "./Config";
import { DebugMethodHandler } from "./DebugMethodHandler";
import { MethodHandlerRIP7560 } from "./MethodHandlerRIP7560";
import { initServer } from "./modules/initServer";

// this is done so that console.log outputs BigNumber as hex string instead of unreadable object
export const inspectCustomSymbol = Symbol.for("nodejs.util.inspect.custom");
// @ts-ignore
ethers.BigNumber.prototype[inspectCustomSymbol] = function () {
	return `BigNumber ${parseInt(this._hex)}`;
};

const CONFIG_FILE_NAME = "workdir/bundler.config.json";

export let showStackTraces = false;

export async function connectContracts(
	wallet: Signer,
	deployNewEntryPoint: boolean = true
): Promise<{ entryPoint?: IEntryPoint }> {
	if (!deployNewEntryPoint) {
		return { entryPoint: undefined };
	}
	const entryPoint = await deployEntryPoint(wallet.provider as any, wallet as any);
	return {
		entryPoint,
	};
}

/**
 * start the bundler server.
 * this is an async method, but only to resolve configuration. after it returns, the server is only active after asyncInit()
 * @param argv
 * @param overrideExit
 */
export async function runBundler(argv: string[], overrideExit = true): Promise<BundlerServer> {
	const program = new Command();

	if (overrideExit) {
		(program as any)._exit = (exitCode: any, code: any, message: any) => {
			class CommandError extends Error {
				constructor(message: string, readonly code: any, readonly exitCode: any) {
					super(message);
				}
			}

			throw new CommandError(message, code, exitCode);
		};
	}

	program
		.version(erc4337RuntimeVersion)
		.option("--beneficiary <string>", "address to receive funds")
		.option("--gasFactor <number>")
		.option("--minBalance <number>", 'below this signer balance, keep fee for itself, ignoring "beneficiary" address ')
		.option("--network <string>", "network name or url")
		.option("--mnemonic <file>", "mnemonic/private-key file of signer account")
		.option("--entryPoint <string>", "address of the supported EntryPoint contract")
		.option("--port <number>", `server listening port (default: ${bundlerConfigDefault.port})`)
		.option("--host <string>", "server host", "localhost")
		.option("--config <string>", "path to config file", CONFIG_FILE_NAME)
		.option("--auto", "automatic bundling (bypass config.autoBundleMempoolSize)", false)
		.option("--unsafe", "UNSAFE mode: no storage or opcode checks (safe mode requires geth)")
		.option("--debugRpc", "enable debug rpc methods (auto-enabled for test node")
		.option("--conditionalRpc", "Use eth_sendRawTransactionConditional RPC)")
		.option("--show-stack-traces", "Show stack traces.")
		.option("--createMnemonic <file>", "create the mnemonic file")
		.option("--useRip7560Mode", "Use this bundler for RIP-7560 node instead of ERC-4337 (experimental).");

	const programOpts = program.parse(argv).opts();
	showStackTraces = programOpts.showStackTraces;

	console.log("command-line arguments: ", program.opts());

	if (programOpts.createMnemonic != null) {
		const mnemonicFile: string = programOpts.createMnemonic;
		console.log("Creating mnemonic in file", mnemonicFile);
		if (fs.existsSync(mnemonicFile)) {
			throw new Error(`Can't --createMnemonic: out file ${mnemonicFile} already exists`);
		}
		const newMnemonic = Wallet.createRandom().mnemonic.phrase;
		fs.writeFileSync(mnemonicFile, newMnemonic);
		console.log("created mnemonic file", mnemonicFile);
		process.exit(1);
	}
	const { config, provider, wallet } = await resolveConfiguration(programOpts);

	const {
		// name: chainName,
		chainId,
	} = await provider.getNetwork();

	if (chainId === 31337 || chainId === 1337) {
		if (config.debugRpc == null) {
			console.log("== debugrpc was", config.debugRpc);
			config.debugRpc = true;
		} else {
			console.log("== debugrpc already st", config.debugRpc);
		}
		if ((await wallet.getBalance()).eq(0)) {
			console.log("=== testnet: fund signer");
			const signer = provider.getSigner();
			await signer.sendTransaction({ to: await wallet.getAddress(), value: parseEther("1") });
		}
	}

	if (
		config.conditionalRpc &&
		!(await supportsRpcMethod(provider as any, "eth_sendRawTransactionConditional", [{}, {}]))
	) {
		console.error("FATAL: --conditionalRpc requires a node that support eth_sendRawTransactionConditional");
		process.exit(1);
	}
	if (!config.unsafe && !(await supportsDebugTraceCall(provider as any, config.useRip7560Mode))) {
		const requiredApi = config.useRip7560Mode ? "eth_traceRip7560Validation" : "debug_traceCall";
		console.error(`FATAL: full validation requires a node with ${requiredApi}. for local UNSAFE mode: use --unsafe`);
		process.exit(1);
	}

	const { entryPoint } = await connectContracts(wallet, !config.useRip7560Mode);
	// bundleSize=1 replicate current immediate bundling mode
	const execManagerConfig = {
		...config,
		// autoBundleMempoolSize: 0
	};
	if (programOpts.auto === true) {
		execManagerConfig.autoBundleMempoolSize = 0;
		execManagerConfig.autoBundleInterval = 0;
	}

	const [execManager, eventsManager, reputationManager, mempoolManager, vm] = initServer(execManagerConfig, wallet);
	const methodHandler = new MethodHandlerERC4337(
		execManager,
		provider,
		wallet,
		config,
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		entryPoint!,
		vm
	);
	const methodHandlerRip7560 = new MethodHandlerRIP7560(execManager, wallet.provider as JsonRpcProvider);

	eventsManager.initEventListener();
	const debugHandler =
		config.debugRpc ?? false
			? new DebugMethodHandler(execManager, eventsManager, reputationManager, mempoolManager)
			: (new Proxy(
					{},
					{
						get(target: {}, method: string, receiver: any): any {
							throw new RpcError(`method debug_bundler_${method} is not supported`, -32601);
						},
					}
			  ) as DebugMethodHandler);

	const bundlerServer = new BundlerServer(methodHandler, methodHandlerRip7560, debugHandler, config, provider, wallet);

	void bundlerServer.asyncStart().then(async () => {
		console.log("Bundle interval (seconds)", execManagerConfig.autoBundleInterval);
		console.log(
			"connected to network",
			await provider.getNetwork().then((net) => {
				return {
					name: net.name,
					chainId: net.chainId,
				};
			})
		);
		console.log(`running on https://${config.host}:${config.port}/rpc`);
	});

	return bundlerServer;
}
