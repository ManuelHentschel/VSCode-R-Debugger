
"use strict";

import { basename } from 'path';
import { DebugRuntime } from './debugRuntime';
import { ProtocolServer } from 'vscode-debugadapter/lib/protocol';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializeRequest, ResponseWithBody, InitializeRequestArguments, ContinueRequest } from './debugProtocolModifications';
import { config, getVSCodePackageVersion } from './utils';

import * as log from 'loglevel';
const logger = log.getLogger("DebugSession");
logger.setLevel(config().get<log.LogLevelDesc>('logLevelSession', 'INFO'));

export class DebugSession extends ProtocolServer {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private THREAD_ID = 1;

	// a runtime (or debugger)
    private _runtime: DebugRuntime;

    private disconnectTimeout: number = config().get<number>('timeouts.startup', 1000);

    sendResponse(response: DebugProtocol.Response): void {
        logger.info("response " + response.request_seq + ": " + response.command, response);
		super.sendResponse(response);
    }
    
    sendEvent(event: DebugProtocol.Event): void {
        logger.info("event: " + event.event, event.body);
        super.sendEvent(event);
    }

    constructor() {
        super();

		// construct R runtime
		this._runtime = new DebugRuntime();

		// setup event handlers
		this._runtime.on('response', (response: DebugProtocol.Response) => {
			this.sendResponse(response);
		});
		this._runtime.on('event', (event: DebugProtocol.Event) => {
			this.sendEvent(event);
		});
		this._runtime.on('output', (text, category: "stdout"|"stderr"|"console" = "stdout", filePath="", line?: number, column?: number, group?: ("start"|"startCollapsed"|"end"), data?: object) => {
            const e: DebugProtocol.OutputEvent = {
                event: 'output',
                seq: 0,
                type: 'event',
                body: {
                    category: category,
                    output: text,
                    group: group,
                    line: line,
                    column: column
                }
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
    }
    static run(debugSession: typeof DebugSession): void {
        const session = new debugSession();
        session.start(process.stdin, process.stdout);
    }

    protected dispatchRequest(request: DebugProtocol.Request) {
        const response: DebugProtocol.Response = {
            command: request.command,
            request_seq: request.seq,
            seq: 0,
            success: true,
            type: 'response'
        };
        var dispatchToR: boolean = false; // the cases handled here are not sent to R
        var sendResponse: boolean = true; // for cases handled here, the response must also be sent from here
        try {
            switch(request.command){
                case 'initialize':
                    const initializeArguments: InitializeRequestArguments = request.arguments || {};
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
                    dispatchToR = true;
                    sendResponse = false;
                    this._runtime.writeOutput('Launch Arguments:\n' + JSON.stringify(request.arguments, undefined, 2));
                    this._runtime.endOutputGroup();
                    break;
                case 'evaluate':
                    const matches = /^### ?[sS][tT][dD][iI][nN]\s*(.*)$/s.exec(request.arguments.expression);
                    if(matches){
                        const toStdin = matches[1];
                        logger.debug('user to stdin:\n' + toStdin);
                        this._runtime.rSession.writeToStdin(toStdin);
                    } else{
                        dispatchToR = true;
                        sendResponse = false;
                    }
                    break;
                case 'disconnect':
                    setTimeout(()=>{
                        console.log('killing R...');
                        this._runtime.killR();
                    }, this.disconnectTimeout);
                    dispatchToR = true;
                    sendResponse = false;
                    break;
                case 'continue':
                    this._runtime.continue(<ContinueRequest>request);
                    dispatchToR = false;
                    sendResponse = false;
                    break;
                case 'pause':
                    // this._runtime.killR('SIGSTOP'); // doesn't work
                    response.success = false;
                    break;
                default:
                    // request not handled here -> send to R
                    dispatchToR = true;
                    sendResponse = false;
            }
            if(dispatchToR){
                this._runtime.dispatchRequest(request);
            } else{
                logger.info("request " + request.seq + " (handled in VS Code): " + request.command, request);
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
