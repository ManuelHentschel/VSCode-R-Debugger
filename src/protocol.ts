

// adapted from:  github/microsoft/vscode-debugadapter-node 

import * as ee from 'events';
import * as vscode from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';


// copied from vscode-debugadapter-node
class Emitter<T> {
	private _event?: Event0<T>;
	private _listener?: (e: T) => void;
	private _this?: any;

	get event(): Event0<T> {
		if (!this._event) {
			this._event = (listener: (e: T) => any, thisArg?: any) => {

				this._listener = listener;
				this._this = thisArg;

				let result: Disposable0;
				result = {
					dispose: () => {
						this._listener = undefined;
						this._this = undefined;
					}
				};
				return result;
			};
		}
		return this._event;
	}

	fire(event: T): void {
		if (this._listener) {
			try {
				this._listener.call(this._this, event);
			} catch (e) {
			}
		}
	}

	hasListener() : boolean {
		return !!this._listener;
	}

	dispose() {
		this._listener = undefined;
		this._this = undefined;
	}
}
interface Disposable0 {
	dispose(): any;
}
interface Event0<T> {
	(listener: (e: T) => any, thisArg?: any): Disposable0;
}


// copied from vscode-debugadapter-node and removed irrelevant code
export class ProtocolServer extends ee.EventEmitter implements vscode.DebugAdapter {

	private sendMessage = new Emitter<DebugProtocol.ProtocolMessage>();

	private sequence: number = 0;

	constructor() {
		super();
	}

	public dispose(): any {
	}

	public onDidSendMessage: Event0<DebugProtocol.ProtocolMessage> = this.sendMessage.event;

	public handleMessage(msg: DebugProtocol.ProtocolMessage): void {
		if(msg.type === 'request') {
			this.dispatchRequest(<DebugProtocol.Request>msg);
		}
	}

	protected sendProtocolMessage(message: DebugProtocol.ProtocolMessage): void {
		message.seq = this.sequence++;
		this.sendMessage.fire(message);
	}

	protected dispatchRequest(request: DebugProtocol.Request): void {
		// To be overwritten in ./debugSession.ts
	}
}
