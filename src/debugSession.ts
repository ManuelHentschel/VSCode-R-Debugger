
"use strict";

import { TerminatedEvent, StoppedEvent, OutputEvent} from 'vscode-debugadapter';


import * as DebugAdapter from 'vscode-debugadapter'; 
import { basename } from 'path';
import { DebugRuntime } from './debugRuntime';
const { Subject } = require('await-notify');



import { Response } from 'vscode-debugadapter/lib/messages';
import { ProtocolServer } from 'vscode-debugadapter/lib/protocol';
import { DebugProtocol } from 'vscode-debugprotocol';

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */

	debugMode: ("function"|"file"|"workspace")
	allowGlobalDebugging: boolean;
	workingDirectory?: string;
	file?: string;
	mainFunction?: string;
	includePackages?: boolean;
	assignToAns?: boolean;
}


export interface InitializeRequestArguments extends DebugProtocol.InitializeRequestArguments {
	rStrings?: {
      delimiter0?: string;
      delimiter1?: string;
      prompt?: string;
      continue?: string;
      startup?: string;
      libraryNotFound?: string;
      packageName?: string;
      append?: string;
	}
}

interface Source extends DebugProtocol.Source {
	srcbody: string;
}
interface SourceArguments extends DebugProtocol.SourceArguments {
	source?: Source;
}


interface ResponseWithBody extends DebugProtocol.Response {
    body?: {[key: string]: any};
}

export class DebugSession extends ProtocolServer {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private THREAD_ID = 1;

	// a runtime (or debugger)
	private _runtime: DebugRuntime;

	private _configurationDone = new Subject();


    sendResponse(response: DebugProtocol.Response): void {
		console.log('response ' + response.request_seq + ': ' + response.command);
		console.log(response);
		super.sendResponse(response);
	}



    public dispatchRequestToR(request: DebugProtocol.Request): void {
		this._runtime.dispatchRequest(request);
	}

    constructor() {
        super();
        this.on('close', () => {
            this.shutdown();
        });
        this.on('error', (error) => {
            this.shutdown();
        });

		// construct R runtime
		this._runtime = new DebugRuntime();

		// setup event handlers
		this._runtime.on('response', (response: DebugProtocol.Response) => {
			this.sendResponse(response);
		});
		this._runtime.on('event', (event: DebugProtocol.Event) => {
			this.sendEvent(event);
		});
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', this.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', this.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', this.THREAD_ID));
		});
		this._runtime.on('stopOnException', (args: any) => {
			const e: DebugProtocol.StoppedEvent = new StoppedEvent('exception', this.THREAD_ID, '');
			e.body = {
				reason : 'exception',
				threadId: 1,
				description: 'Stopped on Exception',
				// text: 'text'
				text: args.message
			};
			this.sendEvent(e);
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


    }
    static run(debugSession: typeof DebugSession): void {
        const session = new debugSession();
        session.start(process.stdin, process.stdout);
    }
    public shutdown() {
        // dummy necessary?
    }
    protected runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void) {
        this.sendRequest('runInTerminal', args, timeout, cb);
    }
    protected dispatchRequest(request: DebugProtocol.Request) {
		console.log("request " + request.seq + ": " + request.command);
        const response: ResponseWithBody = new Response(request);
        try {
            if (request.command === 'initialize') {
                request.arguments = {};
                this.initializeRequest(response, request.arguments, <DebugProtocol.InitializeRequest> request);
            }
            // else if (request.command === 'launch') {
            //     this.launchRequest(response, request.arguments, request);
            // }
            else if (request.command === 'attach') {
                this.attachRequest(response, request.arguments, request);
            }
            else if (request.command === 'disconnect') {
                this.disconnectRequest(response, request.arguments);
            }
            else if (request.command === 'terminate') {
                this.terminateRequest(response, request.arguments, request);
            }
            else if (request.command === 'restart') {
                this.restartRequest(response, request.arguments, request);
            }
            // else if (request.command === 'configurationDone') {
            //     this.configurationDoneRequest(response, request.arguments, request);
            // }
            else if (request.command === 'continue') {
                response.body = {};
                const continueResponse: DebugProtocol.ContinueResponse = <DebugProtocol.ContinueResponse>response;
                this.continueRequest(continueResponse, request.arguments, request);
            }
            else if (request.command === 'next') {
                this.nextRequest(response, request.arguments, request);
            }
            else if (request.command === 'stepIn') {
                this.stepInRequest(response, request.arguments, request);
            }
            else if (request.command === 'stepOut') {
                this.stepOutRequest(response, request.arguments, request);
            }
            else if (request.command === 'pause') {
                this.pauseRequest(response, request.arguments, request);
            }
            else if (request.command === 'source') {
                response.body = {};
                const sourceResponse: DebugProtocol.SourceResponse = <DebugProtocol.SourceResponse>response;
                this.sourceRequest(sourceResponse, request.arguments, request);
            }
            else {
				// is handled by the R package
				console.log("Dispatching to R!");
                this.dispatchRequestToR(request);
            }
        }
        catch (e) {
			console.error("Error while handling request!");
            // ignore
        }
    }
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: InitializeRequestArguments, request: DebugProtocol.InitializeRequest): void {
		this._runtime.initializeRequest(response, args, request);
    }
    protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request) {
        this.sendResponse(response);
    }
    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		this._runtime.terminateFromPrompt();
        this.sendResponse(response);
    }
	protected disconnectRequest(response: DebugProtocol.DisconnectRequest, args: DebugProtocol.DisconnectArguments) {
		this._runtime.terminateFromPrompt();
        this.shutdown();
		// no response to be sent (?)
	}
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments, request?: DebugProtocol.Request): void {
		this._configurationDone.notify();
    }
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void {
		this._runtime.continue();
        this.sendResponse(response);
    }
	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request) {
		this.sendResponse(response);
		this._runtime.step();
	}
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
		this._runtime.stepIn();
		this.sendResponse(response);
    }
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {
		this._runtime.stepOut();
		this.sendResponse(response);
    }
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		this._runtime.returnToPrompt();
        this.sendResponse(response);
    }
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
        this.sendResponse(response);
    }
    protected sourceRequest(response: DebugProtocol.SourceResponse, args: SourceArguments, request?: DebugProtocol.Request): void {
		response.body = {
			content: <string>args.source.srcbody
		};
		this.sendResponse(response);


    }
}
