/* eslint-disable @typescript-eslint/semi */
import {
	Logger, logger,
	LoggingDebugSession, ErrorDestination,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Scope, Handles, Breakpoint, Event
} from 'vscode-debugadapter';
import * as DebugAdapter from 'vscode-debugadapter'; 
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { DebugRuntime, DebugBreakpoint } from './debugRuntime';
import { anyRArgs } from './rSession';
const { Subject } = require('await-notify');


/**
 * This interface describes the r-debugger specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the r-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */

	program: string|undefined;
	debugFunction: boolean;
	debugFile: boolean;
	allowGlobalDebugging: boolean;
	mainFunction: string|undefined;
	workingDirectory: string;
}

interface Source extends DebugProtocol.Source {
	srcbody: string;
}
interface SourceArguments extends DebugProtocol.SourceArguments {
	source?: Source;
}


export class DebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a runtime (or debugger)
	private _runtime: DebugRuntime;

	private _configurationDone = new Subject();

	// private _evalResponses: DebugProtocol.EvaluateResponse[] = [];
	private _breakpointsResponses: DebugProtocol.SetBreakpointsResponse[] = [];
	// private _evalResponses: Record<number, DebugProtocol.EvaluateResponse> = {};
	private _evalResponses = new Map<number, DebugProtocol.EvaluateResponse>();
	private _completionResponses: DebugProtocol.CompletionsResponse[] = [];

	private _logLevel = 3;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();

		// construct R runtime
		this._runtime = new DebugRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', DebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStepPreserveFocus', () => {
			var event: DebugProtocol.StoppedEvent;
			event = new StoppedEvent('step', DebugSession.THREAD_ID);
			event.body.preserveFocusHint = true;
			this.sendEvent(event);
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', DebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', DebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', DebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', (args: any) => {
			const e: DebugProtocol.StoppedEvent = new StoppedEvent('exception', DebugSession.THREAD_ID, '');
			e.body = {
				reason : 'exception',
				threadId: 1,
				description: 'Stopped on Exception',
				// text: 'text'
				text: args.message
			};
			this.sendEvent(e);

			// this.sendEvent(new StoppedEvent('exception', DebugSession.THREAD_ID, 'See debug console'));
		});
		this._runtime.on('breakpointValidated', (bp: DebugBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>bp));
		});
		this._runtime.on('output', (text, category: "stdout"|"stderr"|"console" = "stdout", filePath="", line?: number, column?: number, group?: ("start"|"startCollapsed"|"end")) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body = {
				category: category,
				output: text,
				group: group,
				line: line,
				column: column
			};
			if(filePath !== ''){
				var source: DebugProtocol.Source = new DebugAdapter.Source(basename(filePath), filePath);
				e.body.source = source;
			}
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
		this._runtime.on('evalResponse', (result: {result:string, type:string, variablesReference:number}, id: number) => {
			// const response = this._evalResponses.shift();
			const response = this._evalResponses.get(id);
			if(result.result!==undefined && result.result!=='' || result.variablesReference>0){
				response.body = result;
				this.sendResponse(response);
			} else {
				response.success = false;
				// do not send response to avoid empty line?
				this.sendResponse(response);
			}
		});
		this._runtime.on('breakpointResponse', (breakpoints: any) => { });
		this._runtime.on('completionResponse', (completionsItems: DebugProtocol.CompletionItem[]) => {
			const response = this._completionResponses.shift();
			response.body = {
				targets: completionsItems
			};
			this.sendResponse(response);
		});
	}



	// SETUP
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// support restart
		response.body.supportsRestartRequest = true;

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = false;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ "[", "$", ":", "@" ];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// enable exception-info (not working???)
		response.body.supportsExceptionInfoRequest = false;
		response.body.supportsExceptionOptions = true;
		const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] = [
			{
				filter: 'fromFile',
				label: 'Errors from R file',
				default: true
			},
			{
				filter: 'fromEval',
				label: 'Errors from debug console',
				default: false
			}
		];
		response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;
		
		// enable saving variables to clipboard (not working!!!)
		response.body.supportsClipboardContext = true;

		this.sendResponse(response);

		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}


	// LAUNCH
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		const trace = false;
		const logPath = '';
		logger.init(undefined, logPath, true);

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		// logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		logger.setup(trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,logPath, true);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		// this._runtime.start(args.program, args.allowGlobalDebugging, args.debugFunction, args.mainFunction);
		this._runtime.start(
			args.debugFunction,
			args.debugFile,
			args.allowGlobalDebugging,
			args.workingDirectory,
			args.program,
			args.mainFunction
		);


		this.sendResponse(response);
	}



	// BREAKPOINTS
	// set breakpoints
	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = <string>args.source.path;
		const lines = args.lines || [];

		// clear old breakpoints
		this._runtime.clearBreakpoints(path);

		// set breakpoint locations
		const bps = lines.map(l => {
			const bp = <DebugProtocol.Breakpoint>this._runtime.setBreakPoint(path, l);
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: bps
		};
		this._breakpointsResponses.push(response);
		this.sendResponse(response);
	}

	// get locations
	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, args.line);
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: col
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	// Exception-breakpoints
    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {
		this._runtime.breakOnErrorFromConsole =  args.filters.indexOf('fromEval') > -1;
		this._runtime.breakOnErrorFromFile =  args.filters.indexOf('fromFile') > -1;
		this.sendResponse(response);
	}



	// STACKTRACE AND VARIABLES
	// Threads:
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// supports no threads, just return dummy 
		response.body = {
			threads: [{
				id: DebugSession.THREAD_ID,
				name: "Thread 1"
			}]
		};
		this.sendResponse(response);
	}

	// Stack:
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		// apparently this needs to be answered synchronously to work properly
		// therefore step-responses are sent only after getting stack-info from R

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stack = this._runtime.getStack(startFrame, endFrame);
		response.body = {
			stackFrames: stack['frames'],
			totalFrames: stack['frames'].length
		};

		this.sendResponse(response);
	}

	// Scopes:
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		// can be answered synchronously, since all scopes are received with the stack 
		// (before the breakpoint-event is sent)
		const scopes = this._runtime.getScopes(args.frameId);

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	// Variables:
	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		// is answered async since some variables need to be requested from R
		const variables = await this._runtime.getVariables(args.variablesReference);
		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}


    protected sourceRequest(response: DebugProtocol.SourceResponse, args: SourceArguments, request?: DebugProtocol.Request): void {
		response.body = {
			content: <string>args.source.srcbody
		};
		this.sendResponse(response);

	};



	// COMPLETION
	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments, request?: DebugProtocol.Request): void {
		this._completionResponses.push(response);
		this._runtime.getCompletions(args.frameId, args.text, args.column, args.line);
		// this.sendResponse(response);
	};


	// Exception:
    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void {
		// DUMMY
		// NOT WORKING (why??)
		// const details: DebugProtocol.ExceptionDetails = {
		// 	/** Message contained in the exception. */
		// 	message: 'messageasdf',
		// 	/** Short type name of the exception object. */
		// 	typeName: 'typeNameqwer'
		// 	/** Fully-qualified type name of the exception object. */
		// 	// fullTypeName: 'fullTypeName',
		// 	/** Optional expression that can be evaluated in the current scope to obtain the exception object. */
		// 	// evaluateName: 'evaluateName',
		// 	/** Stack trace at the time the exception was thrown. */
		// 	// stackTrace: 'stackTrace'
		// 	/** Details of the exception contained by this exception, if any. */
		// 	// innerException?: ExceptionDetails[];
		// };
		// response.body = {
        //     /** ID of the exception that was thrown. */
        //     exceptionId: 'dummyFilter',
        //     /** Descriptive text for the exception provided by the debug adapter. */
        //     description: 'description text for the exception',
        //     /** Mode that caused the exception notification to be raised. */
        //     breakMode: 'unhandled',
        //     /** Detailed information about the exception. */
        //     details: details
		// }
		this.sendResponse(response);
	}





	// FLOW CONTROL:
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		this.sendResponse(response);
		this._runtime.step();
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		await this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		const requestIdR = this._runtime.evaluate(args.expression, args.frameId, args.context);
		// this._evalResponses.push(response);
		// this._evalResponses[requestIdR] = response;
		this._evalResponses.set(requestIdR, response);
		// this.logAndSendResponse(response);
	}


	protected terminateRequest(response: DebugProtocol.TerminateRequest, args: DebugProtocol.TerminateArguments) {
		this._runtime.terminateFromPrompt();
		// no response to be sent (?)
		this.sendMissingResponses();
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectRequest, args: DebugProtocol.DisconnectArguments) {
		this._runtime.terminateFromPrompt();
		// no response to be sent (?)
		this.sendMissingResponses();
	}

    protected async restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request) {
		await this._runtime.returnToPrompt();
		this.sendResponse(response);
	};


    protected dispatchRequest(request: DebugProtocol.Request): void {
		console.log('request ' + request.seq + ': ' + request.command);
		super.dispatchRequest(request);
	}

    sendResponse(response: DebugProtocol.Response): void {
		console.log('response ' + response.request_seq + ': ' + response.command);
		super.sendResponse(response);
	}

	private sendMissingResponses() {
		this._breakpointsResponses.forEach(response => {
			this.sendResponse(response);
		});
		this._evalResponses.forEach((response, key) => {
			this.sendResponse(response);
		});
		this._completionResponses.forEach(response => {
			this.sendResponse(response);
		});
	}



	// Dummy code used for debugging:
    protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest?: ErrorDestination): void {};
    runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void): void {console.log('request: runInTerminalRequest');};
    // protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {};
    // protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {};
    // protected launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request): void {};
    protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request): void {};
    // protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {};
    // protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {};
    // protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): void {};
    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {};
    // protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {};
    // protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {};
    // protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void {};
    // protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {};
    // protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {};
    // protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {};
    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void {};
    protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request): void {};
    protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request): void {};
    protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request): void {};
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {};
    // protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {};
    // protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {};
    protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, args: DebugProtocol.TerminateThreadsArguments, request?: DebugProtocol.Request): void {};
    // protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void {};
    // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {};
    // protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void {};
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void {};
    protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): void {};
    // protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void {};
    protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments, request?: DebugProtocol.Request): void {};
    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request): void {};
    // protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments, request?: DebugProtocol.Request): void {};
    // protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void {};
    protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): void {};
    protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): void {};
    protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): void {};
    protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): void {};
    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): void {};
    protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments, request?: DebugProtocol.Request): void {};
    // protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {};
} 
