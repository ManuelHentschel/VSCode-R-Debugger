
"use strict";

import { TerminatedEvent, StoppedEvent, OutputEvent} from 'vscode-debugadapter';


import { basename } from 'path';
import { DebugRuntime } from './debugRuntime';
const { Subject } = require('await-notify');

const { net } = require("net");




import { Response } from 'vscode-debugadapter/lib/messages';
import { ProtocolServer } from 'vscode-debugadapter/lib/protocol';
import { DebugProtocol } from 'vscode-debugprotocol';
import { SourceArguments, InitializeRequest, ContinueArguments, StrictDebugConfiguration, ResponseWithBody, InitializeRequestArguments, ContinueRequest } from './debugProtocolModifications';
import { config, getVSCodePackageVersion } from './utils';

import * as log from 'loglevel';
const logger = log.getLogger("DebugSession");

export class DebugSession extends ProtocolServer {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private THREAD_ID = 1;

	// a runtime (or debugger)
    private _runtime: DebugRuntime;


    sendResponse(response: DebugProtocol.Response): void {
        logger.info("response " + response.request_seq + ": " + response.command, response);
		super.sendResponse(response);
    }
    
    sendEvent(event: DebugProtocol.Event): void {
        logger.info("event: " + event.event);
        if(event.body){
            logger.info(event.body);
        }
        super.sendEvent(event);
    }

    constructor() {
        super();

		logger.setLevel(config().get<log.LogLevelDesc>('logLevelSession', 'INFO'));

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
		this._runtime.on('output', (text, category: "stdout"|"stderr"|"console" = "stdout", filePath="", line?: number, column?: number, group?: ("start"|"startCollapsed"|"end"), data?: object) => {
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
            if(data){
                e.body.data = data;
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

    protected dispatchRequest(request: DebugProtocol.Request) {
        logger.info("request " + request.seq + ": " + request.command, request);
        const response: ResponseWithBody = new Response(request);
        var dispatchToR: boolean = false; // the cases handled here are not sent to R
        var sendResponse: boolean = true; // for cases handled here, the response must also be sent from here
        try {
            switch(request.command){
                case 'initialize':
                    const initializeArguments: InitializeRequestArguments = request.arguments || {};
                    initializeArguments.useJsonServer = config().get<boolean>('useJsonServer', true);
                    initializeArguments.useSinkServer = config().get<boolean>('useSinkServer', true);
                    initializeArguments.threadId = this.THREAD_ID;
                    initializeArguments.extensionVersion = getVSCodePackageVersion();
                    const initializeRequest: InitializeRequest = {
                        arguments: initializeArguments,
                        ...request
                    };
                    this._runtime.initializeRequest(response, initializeRequest.arguments, initializeRequest);
                    sendResponse = false;
                    break;
                case 'launch':
                    if(request.arguments){
                        if(request.arguments.allowGlobalDebugging){
                            this._runtime.allowGlobalDebugging = true;
                        }
                    }
                    dispatchToR = true;
                    sendResponse = false;
                    this._runtime.writeOutput('Launch Arguments:\n' + JSON.stringify(request.arguments, undefined, 2));
                    this._runtime.endOutputGroup();
                    break;
                case 'evaluate':
                    const matches = /^### ?[sS][tT][dD][iI][nN]\s*(.*)$/s.exec(request.arguments.expression);
                    if(matches){
                        const toStdin = matches[1];
                        logger.debug('user cp.stdin:\n' + toStdin);
                        this._runtime.rSession.cp.stdin.write(
                            toStdin + '\n'
                        );
                    } else{
                        dispatchToR = true;
                        sendResponse = false;
                    }
                    break;
                // case 'disconnect':
                //     this._runtime.terminateFromPrompt();
                //     break;
                // case 'terminate':
                //     this._runtime.terminateFromPrompt();
                //     break;
                // case 'restart':
                    // this._runtime.returnToPrompt();
                //     break;
                case 'continue':
                    this._runtime.continue(<ContinueRequest>request);
                    break;
                // case 'next':
                //     this._runtime.step();
                //     break;
                // case 'stepIn':
                //     this._runtime.stepIn();
                //     break;
                // case 'stepOut':
                //     this._runtime.stepOut();
                //     break;
                case 'pause':
                    response.success = false;
                    break;
                // case 'source':
                //     const srcbody = request.arguments.source.srcbody;
                //     if(srcbody){
                //         response.body = {content: srcbody};
                //     }
                //     break;
                default:
                    // request not handled here -> send to R
                    dispatchToR = true;
                    sendResponse = false;
            }
            if(dispatchToR){
                this._runtime.dispatchRequest(request);
            }
            if(sendResponse){
                this.sendResponse(response);
            }
        }
        catch (e) {
			logger.error("Error while handling request " + request.seq + ": " + request.command);
        }
    }
}
