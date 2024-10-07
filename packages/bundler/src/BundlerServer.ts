import { Provider } from "@ethersproject/providers";
import bodyParser from "body-parser";
import cors from "cors";
import { Signer, utils } from "ethers";
import { parseEther } from "ethers/lib/utils";
import express, { Express, Request, Response } from "express";
import { readFileSync } from "fs"; // Для чтения сертификатов
import { createServer, Server } from "https";

import {
	AddressZero,
	decodeRevertReason,
	deepHexlify,
	erc4337RuntimeVersion,
	IEntryPoint__factory,
	packUserOp,
	RpcError,
	UserOperation,
} from "@account-abstraction/utils";

import { BundlerConfig } from "./BundlerConfig";
import { DebugMethodHandler } from "./DebugMethodHandler";
import { MethodHandlerERC4337 } from "./MethodHandlerERC4337";
import { MethodHandlerRIP7560 } from "./MethodHandlerRIP7560";

import Debug from "debug";
import path from "path";

const debug = Debug("aa.rpc");

export class BundlerServer {
	app: Express;
	private readonly httpsServer: Server;
	public silent = false;

	constructor(
		readonly methodHandler: MethodHandlerERC4337,
		readonly methodHandlerRip7560: MethodHandlerRIP7560,
		readonly debugHandler: DebugMethodHandler,
		readonly config: BundlerConfig,
		readonly provider: Provider,
		readonly wallet: Signer
	) {
		this.app = express();
		this.app.use(cors());
		this.app.use(bodyParser.json());

		this.app.get("/", this.intro.bind(this));
		this.app.post("/", this.intro.bind(this));

		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		this.app.post("/rpc", this.rpc.bind(this));

		const options = {
			key: readFileSync(path.resolve(__dirname, "./ssl/key.pem")),
			cert: readFileSync(path.resolve(__dirname, "./ssl/cert.pem")),
		};

		this.httpsServer = createServer(options, this.app);

		this.httpsServer.listen({ port: config.port, host: config.host }, () => {
			console.log("Server is running on port 3000 (HTTPS)");
		});

		this.startingPromise = this._preflightCheck();
	}

	startingPromise: Promise<void>;

	async asyncStart(): Promise<void> {
		await this.startingPromise;
	}

	async stop(): Promise<void> {
		this.httpsServer.close();
	}

	async _preflightCheck(): Promise<void> {
		if (this.config.useRip7560Mode) {
			// TODO: implement preflight checks for the RIP-7560 mode
			return;
		}
		if ((await this.provider.getCode(this.config.entryPoint)) === "0x") {
			this.fatal(`entrypoint not deployed at ${this.config.entryPoint}`);
		}

		// minimal UserOp to revert with "FailedOp"
		const emptyUserOp: UserOperation = {
			sender: AddressZero,
			callData: "0x",
			nonce: 0,
			preVerificationGas: 0,
			verificationGasLimit: 100000,
			callGasLimit: 0,
			maxFeePerGas: 0,
			maxPriorityFeePerGas: 0,
			signature: "0x",
		};
		try {
			const resp = await IEntryPoint__factory.connect(this.config.entryPoint, this.provider).callStatic.getUserOpHash(
				packUserOp(emptyUserOp)
			);

			console.log(resp);
		} catch (e: any) {
			this.fatal(
				`Invalid entryPoint contract at ${this.config.entryPoint}. wrong version? ${
					decodeRevertReason(e, false) as string
				}`
			);
		}

		const signerAddress = await this.wallet.getAddress();
		const bal = await this.provider.getBalance(signerAddress);
		this.log("signer", signerAddress, "balance", utils.formatEther(bal));
		if (bal.eq(0)) {
			this.fatal("cannot run with zero balance");
		} else if (bal.lt(parseEther(this.config.minBalance))) {
			this.log("WARNING: initial balance below --minBalance ", this.config.minBalance);
		}
	}

	fatal(msg: string): never {
		console.error("FATAL:", msg);
		process.exit(1);
	}

	intro(req: Request, res: Response): void {
		res.send(`Account-Abstraction Bundler v.${erc4337RuntimeVersion}. please use "/rpc"`);
	}

	async rpc(req: Request, res: Response): Promise<void> {
		let resContent: any;
		if (Array.isArray(req.body)) {
			resContent = [];
			for (const reqItem of req.body) {
				resContent.push(await this.handleRpc(reqItem));
			}
		} else {
			resContent = await this.handleRpc(req.body);
		}

		try {
			res.send(resContent);
		} catch (err: any) {
			const error = {
				message: err.message,
				data: err.data,
				code: err.code,
			};
			this.log("failed: ", "rpc::res.send()", "error:", JSON.stringify(error));
		}
	}

	async handleRpc(reqItem: any): Promise<any> {
		const { method, params, jsonrpc, id } = reqItem;
		debug(">>", { jsonrpc, id, method, params });
		try {
			const result = deepHexlify(await this.handleMethod(method, params));
			debug("sent", method, "-", result);
			debug("<<", { jsonrpc, id, result });
			return {
				jsonrpc,
				id,
				result,
			};
		} catch (err: any) {
			if (err?.error instanceof Error) {
				err = err.error;
			}
			const error = {
				message: err.message,
				data: err.data,
				code: err.code,
			};
			this.log("failed: ", method, "error:", JSON.stringify(error), err);
			debug("<<", { jsonrpc, id, error });
			return {
				jsonrpc,
				id,
				error,
			};
		}
	}

	async handleMethod(method: string, params: any[]): Promise<any> {
		let result: any;
		switch (method) {
			case "eth_sendTransaction":
				if (!this.config.useRip7560Mode) {
					throw new RpcError(`Method ${method} is not supported`, -32601);
				}
				if (params[0].sender != null) {
					result = await this.methodHandlerRip7560.sendRIP7560Transaction(params[0]);
				}
				break;
			case "eth_getTransactionReceipt":
				if (!this.config.useRip7560Mode) {
					throw new RpcError(`Method ${method} is not supported`, -32601);
				}
				result = await this.methodHandlerRip7560.getRIP7560TransactionReceipt(params[0]);
				break;
			case "eth_chainId":
				const { chainId } = await this.provider.getNetwork();
				result = chainId;
				break;
			case "eth_supportedEntryPoints":
				result = await this.methodHandler.getSupportedEntryPoints();
				break;
			case "eth_sendUserOperation":
				result = await this.methodHandler.sendUserOperation(params[0], params[1]);
				break;
			case "eth_estimateUserOperationGas":
				result = await this.methodHandler.estimateUserOperationGas(params[0], params[1], params[2]);
				break;
			case "eth_getUserOperationReceipt":
				result = await this.methodHandler.getUserOperationReceipt(params[0]);
				break;
			case "eth_getUserOperationByHash":
				result = await this.methodHandler.getUserOperationByHash(params[0]);
				break;
			case "test_validateUserOperation":
				result = await this.methodHandler.validateUserOperation(params[0], params[1], params[2]);
				break;
			case "web3_clientVersion":
				result = this.methodHandler.clientVersion();
				break;
			case "debug_bundler_clearState":
				this.debugHandler.clearState();
				result = "ok";
				break;
			case "debug_bundler_dumpMempool":
				result = await this.debugHandler.dumpMempool();
				break;
			case "debug_bundler_clearMempool":
				this.debugHandler.clearMempool();
				result = "ok";
				break;
			case "debug_bundler_setReputation":
				this.debugHandler.setReputation(params[0]);
				result = "ok";
				break;
			case "debug_bundler_dumpReputation":
				result = this.debugHandler.dumpReputation();
				break;
			case "debug_bundler_clearReputation":
				this.debugHandler.clearReputation();
				result = "ok";
				break;
			case "debug_bundler_setBundlingMode":
				this.debugHandler.setBundlingMode(params[0]);
				result = "ok";
				break;
			case "debug_bundler_setBundleInterval":
				this.debugHandler.setBundleInterval(params[0], params[1]);
				result = "ok";
				break;
			case "debug_bundler_sendBundleNow":
				result = await this.debugHandler.sendBundleNow();
				if (result == null) {
					result = "ok";
				}
				break;
			case "debug_bundler_getStakeStatus":
				result = await this.debugHandler.getStakeStatus(params[0], params[1]);
				break;
			default:
				throw new RpcError(`Method ${method} is not supported`, -32601);
		}
		return result;
	}

	log(...params: any[]): void {
		if (!this.silent) {
			console.log(...arguments);
		}
	}
}
