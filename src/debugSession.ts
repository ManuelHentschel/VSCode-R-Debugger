
"use strict";

import { DebugRuntime } from './debugRuntime';
import { ProtocolServer } from './protocol';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializeRequest, ResponseWithBody, InitializeRequestArguments, ContinueRequest } from './debugProtocolModifications';
import { config, getVSCodePackageVersion } from './utils';

import * as vscode from 'vscode';

import * as log from 'loglevel';
const logger = log.getLogger("DebugSession");
logger.setLevel(config().get<log.LogLevelDesc>('logLevelSession', 'INFO'));


function logMessage(message: DebugProtocol.ProtocolMessage){
    let ret: string = '';
    if(message.type === 'event'){
        const event = <DebugProtocol.Event>message;
        ret = `event: ${event.event}`;
    } else if(message.type === 'response'){
        const response = <DebugProtocol.Response>message;
        ret = `response ${response.request_seq}: ${response.command}`;
    } else{
        ret = `unknown protocol message type: ${message.type}`;
    }
    return ret;
}

export class DebugSession extends ProtocolServer {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private THREAD_ID = 1;

	// a runtime (or debugger)
    private runtime: DebugRuntime;

    private disconnectTimeout: number = config().get<number>('timeouts.startup', 1000);


    sendProtocolMessage(message: DebugProtocol.ProtocolMessage): void {
        logger.info(logMessage(message), message);
        super.sendProtocolMessage(message);
    }

    constructor() {
        super();

		// construct R runtime
		this.runtime = new DebugRuntime();

		// setup event handler
        this.runtime.on('protocolMessage', (message: DebugProtocol.ProtocolMessage) => {
            this.sendProtocolMessage(message);
        });
    }

    // static run(debugSession: typeof DebugSession): void {
    //     const session = new debugSession();
    //     session.start(process.stdin, process.stdout);
    // }

    protected dispatchRequest(request: DebugProtocol.Request) {
        // prepare response
        const response: DebugProtocol.Response = {
            command: request.command,
            request_seq: request.seq,
            seq: 0,
            success: true,
            type: 'response'
        };
        let dispatchToR: boolean = false; // the cases handled here are not sent to R
        let sendResponse: boolean = true; // for cases handled here, the response must also be sent from here
        try {
            switch(request.command){
                case 'initialize':
                    request.arguments = request.arguments || {};
                    request.arguments.threadId = this.THREAD_ID;
                    request.arguments.extensionVersion = getVSCodePackageVersion();
                    this.runtime.initializeRequest(response, request.arguments, <InitializeRequest>request);
                    sendResponse = false;
                    break;
                case 'launch':
                    dispatchToR = true;
                    sendResponse = false;
                    this.runtime.writeOutput('Launch Arguments:\n' + JSON.stringify(request.arguments, undefined, 2));
                    this.runtime.endOutputGroup();
                    break;
                case 'evaluate':
                    const matches = /^### ?[sS][tT][dD][iI][nN]\s*(.*)$/s.exec(request.arguments.expression);
                    if(matches){
                        const toStdin = matches[1];
                        logger.debug('user to stdin:\n' + toStdin);
                        this.runtime.rSession.writeToStdin(toStdin);
                    } else{
                        dispatchToR = true;
                        sendResponse = false;
                    }
                    break;
                case 'disconnect':
                    setTimeout(()=>{
                        console.log('killing R...');
                        this.runtime.killR();
                    }, this.disconnectTimeout);
                    dispatchToR = true;
                    sendResponse = false;
                    break;
                case 'continue':
                    // this.runtime.continue(<ContinueRequest>request);
                    const doc = vscode.window.activeTextEditor.document;
                    if(doc.uri.scheme === 'file'){
                        const filename = doc.fileName;
                        request.arguments.callDebugSource = true;
                        request.arguments.source = {path: filename};
                    };
                    dispatchToR = true;
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
                this.runtime.dispatchRequest(request);
            } else{
                logger.info("request " + request.seq + " (handled in VS Code): " + request.command, request);
            }
            if(sendResponse){
                this.sendProtocolMessage(response);
            }
        }
        catch (e) {
			logger.error("Error while handling request " + request.seq + ": " + request.command);
        }
    }
}
