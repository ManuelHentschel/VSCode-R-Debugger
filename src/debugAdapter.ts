
/* 
This file contains an implementation of vscode.Debugadapter.

DAP messages are received via `DebugAdapter.handleMessage` and sent via
`onDidSendMessage`.

Most messages are simply passed to the R pacakge by calling
`this.debugRuntime.dispatchRequest()`, only some requests are modified/handled
in `this.dispatchRequest()`.
*/

import { DebugRuntime } from './debugRuntime';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializeRequest } from './debugProtocolModifications';
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


export class DebugAdapter implements vscode.DebugAdapter {

    // properties
	private sendMessage = new vscode.EventEmitter<DebugProtocol.ProtocolMessage>(); // used by onDidSendMessage
    private sequence: number = 0; // seq of messages sent to VS Code
	private THREAD_ID = 1; // dummy value
    private runtime: DebugRuntime; // actually handles requests etc. that are not forwarded
    private disconnectTimeout: number = config().get<number>('timeouts.startup', 1000);

    constructor() {
		// construct R runtime
		this.runtime = new DebugRuntime();

		// setup event handler
        this.runtime.on('protocolMessage', (message: DebugProtocol.ProtocolMessage) => {
            this.sendProtocolMessage(message);
        });
    }

    // dummy, required by vscode.Disposable (?)
    public dispose(): void {};
    
    // used to send messages from R to VS Code
	readonly onDidSendMessage: vscode.Event<DebugProtocol.ProtocolMessage> = this.sendMessage.event;

    // used to send messages from VS Code to R
	public handleMessage(msg: DebugProtocol.ProtocolMessage): void {
		if(msg.type === 'request') {
			this.dispatchRequest(<DebugProtocol.Request>msg);
		}
	}

	protected sendProtocolMessage(message: DebugProtocol.ProtocolMessage): void {
        logger.info(logMessage(message), message);
		message.seq = this.sequence++;
		this.sendMessage.fire(message);
	}

    protected dispatchRequest(request: DebugProtocol.Request): void {
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
                        // send directly to stdin, don't send request
                        const toStdin = matches[1];
                        logger.debug('user to stdin:\n' + toStdin);
                        this.runtime.rSession.writeToStdin(toStdin);
                    } else{
                        // dispatch normally
                        dispatchToR = true;
                        sendResponse = false;
                    }
                    break;
                case 'disconnect':
                    // kill R process after timeout, in case it doesn't quit successfully
                    setTimeout(()=>{
                        console.log('killing R...');
                        this.runtime.killR();
                    }, this.disconnectTimeout);
                    dispatchToR = true;
                    sendResponse = false;
                    break;
                case 'continue':
                    // pass info about the currently open text editor
                    // can be used to start .vsc.debugSource(), when called from global workspace
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
                // end cases
            }
        } catch (e) {
            logger.error("Error while handling request " + request.seq + ": " + request.command);
            response.success = false;
            dispatchToR = false;
            sendResponse = true;
        }

        // dispatch to R if not (completely) handled here
        if(dispatchToR){
            this.runtime.dispatchRequest(request);
        } else{
            logger.info("request " + request.seq + " (handled in VS Code): " + request.command, request);
        }

        // send response if (completely) handled here
        if(sendResponse){
            this.sendProtocolMessage(response);
        }
    }
}
