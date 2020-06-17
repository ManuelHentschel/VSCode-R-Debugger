
"use strict";

import { TerminatedEvent, StoppedEvent, OutputEvent} from 'vscode-debugadapter';


import * as DebugAdapter from 'vscode-debugadapter'; 
import { basename } from 'path';
import { DebugRuntime } from './debugRuntime';
const { Subject } = require('await-notify');


import { Response } from 'vscode-debugadapter/lib/messages';
import { ProtocolServer } from 'vscode-debugadapter/lib/protocol';
import { DebugProtocol } from 'vscode-debugprotocol';
import { SourceArguments, InitializeRequestArguments, ContinueArguments, StrictDebugConfiguration, ResponseWithBody } from './debugProtocolModifications';

export class DebugSession extends ProtocolServer {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private THREAD_ID = 1;

	// a runtime (or debugger)
	private _runtime: DebugRuntime;

	private _configurationDone = new Subject();


    sendResponse(response: DebugProtocol.Response): void {
        console.log("reponse " + response.request_seq + ": " + response.command, response);
		super.sendResponse(response);
    }
    
    sendEvent(event: DebugProtocol.Event): void {
        console.log("event: " + event.event);
        if(event.body){
            console.log(event.body);
        }
        super.sendEvent(event);
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
                const source = {
                    name: basename(filePath),
                    path: filePath
                };
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
        console.log('shutting down?');
        // dummy necessary?
    }
    // protected runInTerminalRequest(args: DebugProtocol.RunInTerminalRequestArguments, timeout: number, cb: (response: DebugProtocol.RunInTerminalResponse) => void) {
    //     this.sendRequest('runInTerminal', args, timeout, cb);
    // }
    protected dispatchRequest(request: DebugProtocol.Request) {
        console.log("request " + request.seq + ": " + request.command, request);
        const response: ResponseWithBody = new Response(request);
        var dispatchToR: boolean = false; // the cases handled here are not sent to R
        var sendResponse: boolean = true; // for cases handled here, the response must also be sent from here
        try {
            switch(request.command){
                case 'initialize':
                    const initializeRequest: DebugProtocol.InitializeRequest = {
                        arguments: request.arguments || {},
                        ...request
                    };
                    this._runtime.initializeRequest(response, request.arguments, initializeRequest);
                    sendResponse = false;
                    break;
                case 'disconnect':
                    this._runtime.terminateFromPrompt();
                    break;
                case 'terminate':
                    this._runtime.terminateFromPrompt();
                    break;
                case 'restart':
                    this._runtime.returnToPrompt();
                    break;
                case 'continue':
                    this._runtime.continue(request);
                    break;
                case 'next':
                    this._runtime.step();
                    break;
                case 'stepIn':
                    this._runtime.stepIn();
                    break;
                case 'stepOut':
                    this._runtime.stepOut();
                    break;
                case 'pause':
                    response.success = false;
                    break;
                case 'source':
                    const srcbody = request.arguments.source.srcbody;
                    if(srcbody){
                        response.body = {content: srcbody};
                    }
                    break;
                default:
                    // request not handled here -> send to R
                    dispatchToR = true;
                    sendResponse = false;
            }
            if(dispatchToR){
                this.dispatchRequestToR(request);
            }
            if(sendResponse){
                this.sendResponse(response);
            }
        }
        catch (e) {
			console.error("Error while handling request " + request.seq + ": " + request.command);
        }
    }
}
