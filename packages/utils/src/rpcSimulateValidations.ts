import EntryPointSimulationsJson from "@account-abstraction/contracts/artifacts/EntryPointSimulations.json";
import { packUserOp } from "./ERC4337Utils";

import { UserOperation } from "./interfaces/UserOperation";
import { EntryPointSimulations__factory, IEntryPointSimulations } from "./types";

export const entryPointSimulationsInterface = EntryPointSimulations__factory.createInterface();

/**
 * create the rpc params for eth_call (or debug_traceCall) for simulation method
 * @param methodName the EntryPointSimulations method (simulateValidation or simulateHandleOp)
 * @param entryPointAddress
 * @param userOp
 * @param extraOptions optional added tracer settings
 */
export function simulationRpcParams(
	methodName: string,
	entryPointAddress: string,
	userOp: UserOperation,
	extraParams: any[] = [],
	extraOptions: any = {}
): any[] {
	const data = entryPointSimulationsInterface.encodeFunctionData(
		methodName as any,
		[packUserOp(userOp), ...extraParams] as any
	);
	const tx = {
		to: entryPointAddress,
		data,
	};

	let stateOverride = {};

	if (Object.keys(extraOptions).includes(entryPointAddress))
		stateOverride = {
			[entryPointAddress]: {
				...extraOptions[entryPointAddress],
				code: EntryPointSimulationsJson.deployedBytecode,
			},
		};
	else
		stateOverride = {
			[entryPointAddress]: {
				code: EntryPointSimulationsJson.deployedBytecode,
			},
		};

	return [
		tx,
		"latest",
		{ tracer: "callTracer", enableReturnData: true, stateOverrides: { ...extraOptions, ...stateOverride } },
	];
}

export type SimulateHandleUpResult = IEntryPointSimulations.ExecutionResultStructOutput;

export function decodeSimulateHandleOpResult(data: string): SimulateHandleUpResult {
	return entryPointSimulationsInterface.decodeFunctionResult("simulateHandleOp", data)[0] as SimulateHandleUpResult;
}
