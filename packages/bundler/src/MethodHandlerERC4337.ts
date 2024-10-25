import { JsonRpcProvider, Log } from "@ethersproject/providers";
import { BigNumber, BigNumberish, Signer } from "ethers";

import { calcPreVerificationGas } from "@account-abstraction/sdk";
import {
	AddressZero,
	decodeRevertReason,
	decodeSimulateHandleOpResult,
	deepHexlify,
	erc4337RuntimeVersion,
	IEntryPoint,
	mergeValidationDataValues,
	PackedUserOperation,
	packUserOp,
	requireAddressAndFields,
	requireCond,
	RpcError,
	simulationRpcParams,
	tostr,
	unpackUserOp,
	UserOperation,
	UserOperationEventEvent,
	ValidationErrors,
} from "@account-abstraction/utils";
import { IValidationManager, ValidateUserOpResult } from "@account-abstraction/validation-manager";
import { EventFragment } from "@ethersproject/abi";
import { BundlerConfig } from "./BundlerConfig";
import { ExecutionManager } from "./modules/ExecutionManager";
import { StateOverride, UserOperationByHashResponse, UserOperationReceipt } from "./RpcTypes";

export const HEX_REGEX = /^0x[a-fA-F\d]*$/i;

/**
 * return value from estimateUserOpGas
 */
export interface EstimateUserOpGasResult {
	/**
	 * the preVerification gas used by this UserOperation.
	 */
	preVerificationGas: BigNumberish;
	/**
	 * gas used for validation of this UserOperation, including account creation
	 */
	verificationGasLimit: BigNumberish;

	/**
	 * (possibly future timestamp) after which this UserOperation is valid
	 */
	validAfter?: BigNumberish;

	/**
	 * the deadline after which this UserOperation is invalid (not a gas estimation parameter, but returned by validation
	 */
	validUntil?: BigNumberish;
	/**
	 * estimated cost of calling the account with the given callData
	 */
	callGasLimit: BigNumberish;
	paymasterPostOpGasLimit: BigNumberish;
	paymasterVerificationGasLimit: BigNumberish;
}

type TraceItem = {
	from: string;
	gas: string;
	gasUsed: string;
	to: string;
	input: string;
	output: string;
	calls: TraceItem[];
	value: string;
	error?: string;
	type: string;
};

// type TraceItem = {
// 	action: { from: string; to: string; input: string; callType: string };
// 	error?: string;
// 	result: { gasUsed: string; output: string };
// 	subtraces: number;
// 	traceAddress: any[];
// 	type: string;
// 	children?: TraceItem[];
// };

const EXECUTE_USEROP_SELECTOR = "0x8dd7712f";
const VALIDATE_PAYMASTER_SELECTOR = "0x52b7512c";
const POSTOP_SELECTOR = "0x7c627b21";
const VERIFICATION_SELECTOR = "0x19822f7c";

function getSimulationErrorMessage(traceItem: TraceItem | null): string {
	// Если такой объект существует, вывести необходимые поля
	if (traceItem) {
		return `${traceItem.type} ${traceItem.input} from ${traceItem.from} to ${traceItem.to} reverted with "${traceItem.error}:" ${traceItem.output}`;
	} else {
		return "Unexpected simulation error";
	}
}

function findRevertedCall(node: TraceItem): TraceItem | null {
	// Если это лист (нет детей) и есть ошибка "Reverted", возвращаем этот элемент
	if ((!node.calls || node.calls.length === 0) && node.error && node.type !== "STATICCALL") {
		return node;
	}

	// Если у узла есть дочерние элементы, проверяем их
	if (node.calls) {
		for (const call of node.calls) {
			const result = findRevertedCall(call);
			if (result) {
				return result;
			}
		}
	}

	// Если ни один дочерний элемент не подошел, возвращаем null
	return null;
}

function getCallFromTrace(trace: TraceItem, from: string, to: string, selector: string): TraceItem | null {
	if (trace.from === from && trace.to === to && trace.input.substring(0, 10) === selector) {
		return trace;
	}

	// Если у узла есть дочерние элементы, проверяем их
	if (trace.calls) {
		for (const call of trace.calls) {
			const result = getCallFromTrace(call, from, to, selector);
			if (result) {
				return result;
			}
		}
	}

	return null;
}

function getDepth(traceItem: TraceItem): number {
	// Base case: if there are no calls, the depth is 1
	if (!traceItem.calls || traceItem.calls.length === 0) {
		return 1;
	}

	// Recursive case: find the depth of each call and add 1 for the current level
	let maxDepth = 0;
	for (const call of traceItem.calls) {
		const callDepth = getDepth(call);
		if (callDepth > maxDepth) {
			maxDepth = callDepth;
		}
	}

	return maxDepth + 1;
}

function getCallGasLimit(call: TraceItem | null) {
	if (!call) throw new RpcError("No call was made. Was that intentional?", ValidationErrors.UserOperationReverted);
	if (call?.error) throw new RpcError(getSimulationErrorMessage(call), ValidationErrors.UserOperationReverted, call);

	const depth = BigInt(getDepth(call));

	return (BigInt(call.gasUsed) * BigInt(64) ** depth) / BigInt(63) ** depth + BigInt(2000);
}

export class MethodHandlerERC4337 {
	constructor(
		readonly execManager: ExecutionManager,
		readonly provider: JsonRpcProvider,
		readonly signer: Signer,
		readonly config: BundlerConfig,
		readonly entryPoint: IEntryPoint,
		readonly vm: IValidationManager
	) {}

	async getSupportedEntryPoints(): Promise<string[]> {
		return [this.config.entryPoint];
	}

	async selectBeneficiary(): Promise<string> {
		const currentBalance = await this.provider.getBalance(this.signer.getAddress());
		let beneficiary = this.config.beneficiary;
		// below min-balance redeem to the signer, to keep it active.
		if (currentBalance.lte(this.config.minBalance)) {
			beneficiary = await this.signer.getAddress();
			console.log("low balance. using ", beneficiary, "as beneficiary instead of ", this.config.beneficiary);
		}
		return beneficiary;
	}

	async _validateParameters(
		userOp1: UserOperation,
		entryPointInput: string,
		requireSignature = true,
		requireGasParams = true
	): Promise<void> {
		requireCond(entryPointInput != null, "No entryPoint param", -32602);

		if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
			throw new Error(
				`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`
			);
		}
		// minimal sanity check: userOp exists, and all members are hex
		requireCond(userOp1 != null, "No UserOperation param", ValidationErrors.InvalidFields);
		const userOp = userOp1 as any;

		const fields = ["sender", "nonce", "callData"];
		if (requireSignature) {
			fields.push("signature");
		}
		if (requireGasParams) {
			fields.push("preVerificationGas", "verificationGasLimit", "callGasLimit", "maxFeePerGas", "maxPriorityFeePerGas");
		}
		fields.forEach((key) => {
			requireCond(userOp[key] != null, "Missing userOp field: " + key, -32602);
			const value: string = userOp[key].toString();
			requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, -32602);
		});
		requireAddressAndFields(
			userOp,
			"paymaster",
			["paymasterPostOpGasLimit", "paymasterVerificationGasLimit"],
			["paymasterData"]
		);
		requireAddressAndFields(userOp, "factory", ["factoryData"]);
	}

	/**
	 * eth_estimateUserOperationGas RPC api.
	 * @param userOp1 input userOp (may have gas fields missing, so they can be estimated)
	 * @param entryPointInput
	 * @param stateOverride
	 */
	async estimateUserOperationGas(
		userOp: UserOperation,
		entryPointInput: string,
		stateOverride?: StateOverride
	): Promise<EstimateUserOpGasResult> {
		const provider = this.provider;

		// todo: checks the existence of parameters, but since we hexlify the inputs, it fails to validate
		await this._validateParameters(deepHexlify(userOp), entryPointInput);
		// todo: validation manager duplicate?

		const rpcParams = simulationRpcParams(
			"simulateHandleOp",
			this.entryPoint.address,
			userOp,
			[AddressZero, "0x"],
			stateOverride
		);

		const trace = await provider.send("debug_traceCall", rpcParams).catch((e: any) => {
			throw new RpcError(decodeRevertReason(e) as string, ValidationErrors.SimulateValidation);
		});

		if (trace.error) {
			let message;

			const errorTraceItem = findRevertedCall(trace);

			if (errorTraceItem) message = getSimulationErrorMessage(errorTraceItem);
			else message = decodeRevertReason(trace.output);

			throw new RpcError(
				message ?? "Unexpected error during gas estimation",
				ValidationErrors.UserOperationReverted,
				errorTraceItem
			);
		}

		const returnInfo = decodeSimulateHandleOpResult(trace.output);

		const { validAfter, validUntil } = mergeValidationDataValues(
			returnInfo.accountValidationData,
			returnInfo.paymasterValidationData
		);
		const { preOpGas } = returnInfo;

		const executeCall = getCallFromTrace(
			trace,
			this.entryPoint.address.toLowerCase(),
			userOp.sender.toLowerCase(),
			EXECUTE_USEROP_SELECTOR
		);
		const validatePaymasterCall = getCallFromTrace(
			trace,
			this.entryPoint.address.toLowerCase(),
			userOp.paymaster!.toLowerCase(),
			VALIDATE_PAYMASTER_SELECTOR
		);
		const postOpCall = getCallFromTrace(
			trace,
			this.entryPoint.address.toLowerCase(),
			userOp.paymaster!.toLowerCase(),
			POSTOP_SELECTOR
		);
		const verificationCall = getCallFromTrace(
			trace,
			this.entryPoint.address.toLowerCase(),
			userOp.sender.toLowerCase(),
			VERIFICATION_SELECTOR
		);

		const callGasLimit = getCallGasLimit(executeCall);
		const actualPaymasterVerificationGasLimit = getCallGasLimit(validatePaymasterCall); // constant for _validatePaymasterPrepayment execution
		const paymasterPostOpGasLimit = getCallGasLimit(postOpCall);
		const actualAccountVerificationGasLimit = getCallGasLimit(verificationCall);

		const epValidationGas =
			preOpGas.toBigInt() - actualAccountVerificationGasLimit - actualPaymasterVerificationGasLimit;

		const [accountValidationGasOverhead, paymasterValidationGasOverhead] = [
			(epValidationGas * BigInt(57)) / BigInt(100),
			(epValidationGas * BigInt(43)) / BigInt(100),
		];

		const verificationGasLimit = actualAccountVerificationGasLimit + accountValidationGasOverhead + BigInt(3000);
		const paymasterVerificationGasLimit =
			actualPaymasterVerificationGasLimit + paymasterValidationGasOverhead + BigInt(3000);

		userOp.preVerificationGas = 50_000;

		const preVerificationGas = calcPreVerificationGas(deepHexlify(userOp));

		return {
			preVerificationGas,
			verificationGasLimit,
			validAfter,
			validUntil,
			callGasLimit,
			paymasterPostOpGasLimit,
			paymasterVerificationGasLimit,
		};
	}

	async validateUserOperation(
		userOp: UserOperation,
		entryPointInput: string,
		stateOverride: StateOverride
	): Promise<ValidateUserOpResult> {
		this.vm.validateInputParameters(userOp, entryPointInput);

		console.log(
			`Validating UserOperation: Sender=${userOp.sender}  Nonce=${tostr(
				userOp.nonce
			)} EntryPoint=${entryPointInput} Paymaster=${userOp.paymaster ?? ""}`
		);

		return await this.vm.validateUserOp(userOp, undefined, true, stateOverride);
	}

	async sendUserOperation(userOp: UserOperation, entryPointInput: string): Promise<string> {
		await this._validateParameters(userOp, entryPointInput);

		console.log(
			`UserOperation: Sender=${userOp.sender}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput} Paymaster=${
				userOp.paymaster ?? ""
			}`
		);
		await this.execManager.sendUserOperation(userOp, entryPointInput);
		return await this.entryPoint.getUserOpHash(packUserOp(userOp));
	}

	async _getUserOperationEvent(userOpHash: string): Promise<UserOperationEventEvent> {
		const blockSpan = 9999;
		const currentBlockNumber = await this.provider.getBlockNumber();
		// TODO: eth_getLogs is throttled. must be acceptable for finding a UserOperation by hash
		const event = await this.entryPoint.queryFilter(
			this.entryPoint.filters.UserOperationEvent(userOpHash),
			currentBlockNumber - blockSpan
		);
		return event[0];
	}

	// filter full bundle logs, and leave only logs for the given userOpHash
	// @param userOpEvent - the event of our UserOp (known to exist in the logs)
	// @param logs - full bundle logs. after each group of logs there is a single UserOperationEvent with unique hash.
	_filterLogs(userOpEvent: UserOperationEventEvent, logs: Log[]): Log[] {
		let startIndex = -1;
		let endIndex = -1;
		const events = Object.values(this.entryPoint.interface.events);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const beforeExecutionTopic = this.entryPoint.interface.getEventTopic(
			events.find((e: EventFragment) => e.name === "BeforeExecution")!
		);
		logs.forEach((log, index) => {
			if (log?.topics[0] === beforeExecutionTopic) {
				// all UserOp execution events start after the "BeforeExecution" event.
				startIndex = endIndex = index;
			} else if (log?.topics[0] === userOpEvent.topics[0]) {
				// process UserOperationEvent
				if (log.topics[1] === userOpEvent.topics[1]) {
					// it's our userOpHash. save as end of logs array
					endIndex = index;
				} else {
					// it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
					if (endIndex === -1) {
						startIndex = index;
					}
				}
			}
		});
		if (endIndex === -1) {
			throw new Error("fatal: no UserOperationEvent in logs");
		}
		return logs.slice(startIndex + 1, endIndex);
	}

	async getUserOperationByHash(userOpHash: string): Promise<UserOperationByHashResponse | null> {
		requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, "Missing/invalid userOpHash", -32602);
		const event = await this._getUserOperationEvent(userOpHash);
		if (event == null) {
			return null;
		}
		const tx = await event.getTransaction();
		if (tx.to !== this.entryPoint.address) {
			throw new Error("unable to parse transaction");
		}
		const parsed = this.entryPoint.interface.parseTransaction(tx);
		const ops: PackedUserOperation[] = parsed?.args.ops;
		if (ops == null) {
			throw new Error("failed to parse transaction");
		}
		const op = ops.find((op) => op.sender === event.args.sender && BigNumber.from(op.nonce).eq(event.args.nonce));
		if (op == null) {
			throw new Error("unable to find userOp in transaction");
		}

		return deepHexlify({
			userOperation: unpackUserOp(op),
			entryPoint: this.entryPoint.address,
			transactionHash: tx.hash,
			blockHash: tx.blockHash ?? "",
			blockNumber: tx.blockNumber ?? 0,
		});
	}

	async getUserOperationReceipt(userOpHash: string): Promise<UserOperationReceipt | null> {
		requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, "Missing/invalid userOpHash", -32602);
		const event = await this._getUserOperationEvent(userOpHash);
		if (event == null) {
			return null;
		}
		const receipt = await event.getTransactionReceipt();
		const logs = this._filterLogs(event, receipt.logs);
		return deepHexlify({
			userOpHash,
			sender: event.args.sender,
			nonce: event.args.nonce,
			actualGasCost: event.args.actualGasCost,
			actualGasUsed: event.args.actualGasUsed,
			success: event.args.success,
			logs,
			receipt,
		});
	}

	clientVersion(): string {
		// eslint-disable-next-line
		return "aa-bundler/" + erc4337RuntimeVersion + (this.config.unsafe ? "/unsafe" : "");
	}
}
