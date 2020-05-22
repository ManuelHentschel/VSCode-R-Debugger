import {
	Logger, logger,
	LoggingDebugSession, ErrorDestination,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { DebugRuntime, DebugBreakpoint } from './debugRuntime';
const { Subject } = require('await-notify');


/**
 * This interface describes the r-debugger specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the r-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
}

export class DebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// a runtime (or debugger)
	private _runtime: DebugRuntime;

	private _configurationDone = new Subject();

	private _evalResponses: DebugProtocol.EvaluateResponse[] = [];
	private _breakpointsResponses: DebugProtocol.SetBreakpointsResponse[] = [];

	private _logLevel = 3;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		// super("r-debugger.txt");
		super();


		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new DebugRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', DebugSession.THREAD_ID));
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
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', DebugSession.THREAD_ID, 'Informative exception text'));
		});
		this._runtime.on('breakpointValidated', (bp: DebugBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>bp));
		});
		this._runtime.on('output', (text, category: "stdout"|"stderr"|"console" = "stdout", filePath="", line=1, column=1) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			const matches = /(start|startCollapsed|end): ?(.*)/.exec(text);
			if (matches) {
				switch(matches[1]){
					case "start":
						e.body.group = "start";
						break;
					case "startCollapsed":
						e.body.group = "startCollapsed";
						break;
					default:
						e.body.group = "end";
				}
				e.body.output = matches[2];
			} else {
				e.body.output = text;
			}
			e.body.category = category;
			if(filePath !== ''){
				var source: DebugProtocol.Source = new Source(basename(filePath), filePath);
				e.body.source = source;
			} else {
				// e.body.source = new Source('');
			}
			e.body.line = line;
			e.body.column = column;
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
		this._runtime.on('evalResponse', (result: string) => {
			const response = this._evalResponses.shift();
			if(result.length>0){
				response.body = {
					result: result,
					variablesReference: 0
				};
			} else {
				response.success = false;
			}
			this.logAndSendResponse(response);
		});
		this._runtime.on('breakpointResponse', (breakpoints: any) => {

		})
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = false;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// enable exception-info (not working???)
		response.body.supportsExceptionInfoRequest = true;
		response.body.supportsExceptionOptions = true;
		const exceptionBreakpointFilters: DebugProtocol.ExceptionBreakpointsFilter[] = [{
			filter: 'dummyFilter',
			label: 'dummyFilterLabel',
			default: true
		}];
		response.body.exceptionBreakpointFilters = exceptionBreakpointFilters;
		
		// enable saving variables to clipboard
		response.body.supportsClipboardContext = true;

		this.logAndSendResponse(response);

		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	private logRequest(response: DebugProtocol.Response){
		if(this._logLevel>=3){
			console.log('request ' + response.request_seq + ': ' + response.command);
		}
	}
	private logResponse(response: DebugProtocol.Response){
		if(this._logLevel>=3){
			console.log('response ' + response.request_seq + ': ' + response.command);
		}
	}
	private logAndSendResponse(response: DebugProtocol.Response){
		this.logResponse(response);
		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this.logRequest(response)
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		const trace = false
		const logPath = '';
		logger.init(undefined, logPath, true)

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		// logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);
		logger.setup(trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,logPath, true);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		this._runtime.start(args.program);

		this.logAndSendResponse(response);
	}

	// protected setExceptionBreakpointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
	// protected setExceptionBreakpointsRequest(response: any=undefined, args: any=undefined, args2: any=undefined): void {
    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {
		this.logRequest(response);
		this.logAndSendResponse(response);
	}

	// protected setExceptionBreakpointsRequest(response: DebugProtocol.SetExceptionBreakpointsRequest, args: DebugProtocol.SetBreakpointsArguments): void {
		// this.logRequest(response);
		// this.logAndSendResponse(response);
	// }

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		const path = <string>args.source.path;
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints = clientLines.map(l => {
			let { verified, line, id } = this._runtime.setBreakPoint(path, l);
			const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, l);
			bp.id = id;
			return bp;
		});

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this._breakpointsResponses.push(response)
		this.logAndSendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.logAndSendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		this.logRequest(response);
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(DebugSession.THREAD_ID, "thread 1")
			]
		};
		this.logAndSendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		this.logRequest(response);

		//apparently this needs to be answered synchronously to work properly
		//therefore step-responses are sent only after getting stack-info from R

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const stack = this._runtime.getStack(startFrame, endFrame);
		response.body = {
			stackFrames: stack['frames'],
			totalFrames: stack['frames'].length
		};

		this.logAndSendResponse(response);
	}



	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		this.logRequest(response);
		const scopes = this._runtime.getScopes(args.frameId);

		response.body = {
			scopes: scopes
		};
		this.logAndSendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		this.logRequest(response);

		const variables = await this._runtime.getVariables(args.variablesReference);
		response.body = {
			variables: variables
		};
		this.logAndSendResponse(response);
	}

    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void {
		// DUMMY
		// NOT WORKING
		this.logRequest(response);
		const details: DebugProtocol.ExceptionDetails = {
			/** Message contained in the exception. */
			message: 'messageasdf',
			/** Short type name of the exception object. */
			typeName: 'typeNameqwer'
			/** Fully-qualified type name of the exception object. */
			// fullTypeName: 'fullTypeName',
			/** Optional expression that can be evaluated in the current scope to obtain the exception object. */
			// evaluateName: 'evaluateName',
			/** Stack trace at the time the exception was thrown. */
			// stackTrace: 'stackTrace'
			/** Details of the exception contained by this exception, if any. */
			// innerException?: ExceptionDetails[];
		};
		response.body = {
            /** ID of the exception that was thrown. */
            exceptionId: 'dummyFilter',
            /** Descriptive text for the exception provided by the debug adapter. */
            description: 'description text for the exception',
            /** Mode that caused the exception notification to be raised. */
            breakMode: 'unhandled',
            /** Detailed information about the exception. */
            details: details
		}

		this.logAndSendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.logRequest(response);
		this._runtime.continue();
		this.logAndSendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this._runtime.continue(true);
		this.logAndSendResponse(response);
 	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		this.logRequest(response);
		this.logAndSendResponse(response);
		this._runtime.step();
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		await this._runtime.stepIn();
		this.logAndSendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._runtime.stepOut();
		this.logAndSendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this._runtime.step(true);
		this.logAndSendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		this.logRequest(response);
		this._evalResponses.push(response);
		this._runtime.evaluate(args.expression, args.frameId, args.context);
		// this.logAndSendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		this.logAndSendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		this.logAndSendResponse(response);
	}


	protected terminateRequest(response: DebugProtocol.TerminateRequest, args: DebugProtocol.TerminateArguments) {
		this._runtime.terminateFromBrowser();
		// no response to be sent (?)
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectRequest, args: DebugProtocol.DisconnectArguments) {
		this._runtime.terminateFromBrowser();
		// no response to be sent (?)
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		// this._runtime.cancel();
		this.logAndSendResponse(response);
	}


	// Dummy code used for debugging:

    protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest?: ErrorDestination): void {this.logRequest(response)};
    runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void): void {console.log('request: runInTerminalRequest')};
    // protected dispatchRequest(request: DebugProtocol.Request): void {console.log('request: dispatchRequest')};
    // protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {};
    // protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {};
    // protected launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request): void {};
    protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {};
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request): void {};
    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {};
    // protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void {};
    // protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {};
    // protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {};
    // protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {};
    // protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments, request?: DebugProtocol.Request): void {};
    // protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments, request?: DebugProtocol.Request): void {};
    protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {};
    protected terminateThreadsRequest(response: DebugProtocol.TerminateThreadsResponse, args: DebugProtocol.TerminateThreadsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): void {};
    // protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {};
    // protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): void {};
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): void {};
    protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void {};
    protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): void {};
    // protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): void {};
    protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments, request?: DebugProtocol.Request): void {this.logRequest(response)};
    // protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments, request?: DebugProtocol.Request): void {};
    // protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {};
} 
