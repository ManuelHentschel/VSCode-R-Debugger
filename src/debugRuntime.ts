/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// import { readFileSync, write } from 'fs';
import { EventEmitter } from 'events';
// import { Terminal, window } from 'vscode';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import {getRPath, getTerminalPath, escapeForRegex } from "./utils";
import { TextDecoder, isUndefined } from 'util';

import {toRStringLiteral, RSession} from './rSession';
import { DebugProtocol } from 'vscode-debugprotocol';

// import * as debugadapter from 'vscode-debugadapter';

import * as child from 'child_process';
import { runInThisContext } from 'vm';
const { Subject } = require('await-notify');

const path = require('path');
export interface DebugBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export class DebugRuntime extends EventEmitter {

	// the initial file we are 'debugging'
	private sourceFile: string;

	// This is the next line that will be 'executed'
	private currentLine = 0;
	private currentFile = this.sourceFile;

	// maps from sourceFile to array of breakpoints
	private _breakPoints = new Map<string, DebugBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;


	private cp!: child.ChildProcessWithoutNullStreams;
	private rSession!: RSession;

	private isRunningMain: boolean = false;
	private isPaused: boolean = false;
	private isCrashed: boolean = false;
	private ignoreOutput: boolean = false;

	private useRCommandQueue: boolean = true;
	private waitBetweenRCommands: number = 0;

	// debugging
	private logLevel = 3;

	// used to store text if only part of a line is read form cp.stdout/cp.sterr
	private restOfStdout: string = "";
	private restOfStderr: string = "";

	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details

	private stack: any = undefined; //TODO specify type!
	private requestId = 0; // id of the last function call made to R (not all function calls need to be numbered)
	private messageId = 0; // id of the last function call response received from R (only updated if larger than the previous)
	private lastStackId = 0; // id of the last stack-message received from R
	private sendEventOnStack: string = ''; // send this event upon receiving the next Stack-message

	private zeroCounter: number = 0; // counts the number of message-ids = 0 in a row (used for debugging)

	private variables: Record<number, DebugProtocol.Variable[]> = {};

	// delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// need to match those used in the R-package
	readonly delimiter0 = '<v\\s\\c>';
	readonly delimiter1 = '</v\\s\\c>';
	readonly rprompt = '<#v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rStartup = '<v\\s\\c\\R\\STARTUP>'
	readonly libraryNotFoundString = '<v\\s\\c\\LIBRARY\\NOT\\FOUND>';
	readonly packageName = 'vscDebugger';

	// is set to true, once R has started up
	private rReady: boolean = false;


	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean) {
		this.sourceFile = program;
		
		// read settings from vsc-settings
		const config = workspace.getConfiguration('rdebugger');
		this.useRCommandQueue = config.get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config.get<number>('waitBetweenRCommands', 0);

		// print some info about the rSession
		this.sendEvent('output', 'startCollapsed: Starting R session...');
		this.sendEvent('output',`delimiter0: ${this.delimiter0}\ndelimiter1:${this.delimiter1}\nR-Prompt: ${this.rprompt}`);

		// is set to true, once main() is called in R
		this.isRunningMain = false;
		
		// start R in child process
		const terminalPath = getTerminalPath();
		const rPath = getRPath();
		const cwd = path.dirname(program);
		const rArgs = ['--ess', '--quiet', '--interactive', '--no-save'];
		this.sendEvent('output', 'terminalPath: ' + terminalPath + '\ncwd: ' + cwd + '\nrPath: ' + rPath + '\nrArgs: ' + rArgs.join(' '))
		this.rSession = new RSession(terminalPath, rPath, cwd, rArgs);
		this.rSession.waitBetweenCommands = this.waitBetweenRCommands;
		if(!this.rSession.successTerminal){
            vscode.window.showErrorMessage('Terminal path not valid!');
			this.terminate();
			return;
		}
		
		// handle output from the R-process
		this.rSession.cp.stdout.on("data", data => {
			this.handleData(data);
		});
		this.rSession.cp.stderr.on("data", data => {
			this.handleData(data, true);
		});


		// check if R has started
		// cat message from R
		this.rSession.callFunction('cat', [toRStringLiteral(this.rStartup), '"\\n"']);

		// set timeout
		const ms = 1000;
		let timeout = new Promise((resolve, reject) => {
			let id = setTimeout(() => {
			clearTimeout(id);
			resolve(false)
			}, ms)
		})

		// wait for message from R (or for the timeout)
		const successR = await Promise.race([timeout, this.waitForR()])

		// abort if the terminal does not print the message (--> R has not started!)
		if(!successR){
            vscode.window.showErrorMessage('R path not valid!');
			this.terminate();
			return;
		}

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by the rSession.cp.stdout handler
		this.sendEvent('output', 'library: ' + this.packageName);
		const libraryCommandArgs = {
			expr: 'base::library(' + this.packageName + ')',
			error: 'function(e){base::cat(' + toRStringLiteral(this.libraryNotFoundString) + ',"\\n")}'
		}
		this.rSession.callFunction('tryCatch', libraryCommandArgs, 'base')

		// source file that is being debugged
		this.sendEvent('output', 'program: ' + program)
		this.rSession.callFunction('source', [toRStringLiteral(program)], 'base');

		// all R function calls from here on are meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.packageName;

		// set breakpoints in R
		this._breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
			bps.forEach((bp: DebugBreakpoint) => {
				this.rSession.callFunction('.vsc.mySetBreakpoint', [toRStringLiteral(path), bp.line]);
			});
		});


		// call main()
		// TODO: replace runMain() with direct main() call?
		const options = {
			overwritePrint: config.get<boolean>('overwritePrint', false),
			overwriteCat: config.get<boolean>('overwriteCat', false)
		}
		this.rSession.callFunction('.vsc.runMain', options);
		this.sendEvent('output', 'end: '); // end info group
	}

	private async waitForR(){
		const poll = (resolve: (boolean) => void) => {
			if(this.rReady){
				resolve(true);
			} else {
				setTimeout(_ => poll(resolve), 100);
			}
		};
		return new Promise(poll);
	}

	private async timeout(ms: number = 1000){

	}

	private writeOutput(text: any, addNewline = false, toStderr = false, filePath = '', line = 1){
		// writes output to the debug console
		if(text.slice(-1) !== '\n' && addNewline){
			text = text + '\n';
		}

		const category = (toStderr ? "stderr" : "stdout");
		this.sendEvent("output", text, category, filePath, line);
	}

	//////////
	// Output-handlers:
	//////////
	
	private async handleData(data: any, fromStderr: boolean = false) {
		// handles output from the R child process
		// splits cp.stdout into lines / waits for complete lines
		// calls handleLine() on each line

		if(this.ignoreOutput){
			return;
		}

		const dec = new TextDecoder;
		var s = dec.decode(data);
		s = s.replace(/\r/g,''); //keep only \n as linebreak

		// join with rest text from previous call(s)
		if(fromStderr){
			s = this.restOfStderr + s;
			this.restOfStderr = "";
		} else {
			s = this.restOfStdout + s;
			this.restOfStdout = "";
		}

		// split into lines
		const lines = s.split(/\n/);

		// handle all the complete lines
		for(var i = 0; i<lines.length - 1; i++){
			await this.handleLine(lines[i], fromStderr);
		}

		if(lines.length > 0) {
			// calls this.handleLine on the remainder of the last line
			// necessary, since e.g. input prompt (">") does not send a newline
			var remainingText = lines[lines.length - 1];
			// handleLine returns the parts of a line that were not 'understood'
			remainingText = await this.handleLine(remainingText, fromStderr, false);
			
			// remember parts that were no understood for next call
			if(fromStderr){
				this.restOfStderr = remainingText;
			} else {
				this.restOfStdout = remainingText;
			}
		}
	}
	

	private async handleLine(line: string, fromStderr = false, isFullLine = true) {
		// onlye show the line to the user if it is complete & relevant
		var showLine = isFullLine && !this.stdoutIsBrowserInfo && this.isRunningMain;

		// temp variables for regexes and matches
		var tmpRegex: RegExp;
		var tmpMatches: any;
		
		// regex to identify info meant for vsc
		const debugRegex = new RegExp(escapeForRegex(this.delimiter0) + '(.*)' + escapeForRegex(this.delimiter1));
		// regex to identify the R-prompt
		const promptRegex = new RegExp(escapeForRegex(this.rprompt));

		// filter out info meant for vsc:
		tmpMatches = debugRegex.exec(line);
		if(tmpMatches){
			// is meant for the debugger, not the user
			await this.handleJson(tmpMatches[1]);
			line = line.replace(debugRegex, '');
		}

		// Check for R-Startup message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.rStartup)).test(line)){
			console.log('R startup')
			this.rReady = true;
		}

		// Check for Library-Not-Found-Message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.libraryNotFoundString)).test(line)){
			console.error('Library not found!');
			vscode.window.showErrorMessage('Please install the R package "' + this.packageName + '"!');
			this.terminateFromBrowser();
		}

		// read info about the browser/debugger
		tmpRegex = /Browse\[\d+\]> /;
		if(tmpRegex.test(line)){
			// R has entered the browser (usually caused by a breakpoint)
			if(!this.isPaused){
				this.isPaused = true;
			}
			line = line.replace(tmpRegex,'');
			showLine = false;
			this.stdoutIsBrowserInfo = false;
			console.log('shows prompt');
			this.rSession.showsPrompt();
		} 
		if(/Called from: (.*)\n/.test(line)){
			// part of browser-info
			showLine = false;
		}
		if(isFullLine && (/debug: /.test(line) ||
				/exiting from: /.test(line) ||
				/debugging in: /.test(line))){
			// part of browser-info
			showLine = false;
			this.stdoutIsBrowserInfo = true;
		}
		tmpMatches = /^debug at (.*)#(\d+): .*$/.exec(line);
		if(tmpMatches){
			// part of browser-info
			this.currentFile = tmpMatches[1];
			this.currentLine = parseInt(tmpMatches[2]);
			try {
				this.stack['frames'][0]['line'] = this.currentLine;
			} catch(error){}
			showLine = false;
			this.stdoutIsBrowserInfo = true;
		}

		// identify echo of commands sent by vsc
		if(isFullLine && /^[ncsfQ]$/.test(line)) {
			// commands used to control the browser
			console.log('matches: [ncsfQ]');
			showLine = false;
		}
		tmpRegex = new RegExp(this.packageName + '::' + '\\.vsc\\.')
		if(isFullLine && tmpRegex.test(line)) {
			// was a command sent to R by the debugger
			console.log('matches: .vsc');
			showLine = false;
		}

		// check for prompt
		if(this.isRunningMain && promptRegex.test(line) && isFullLine){
			console.log("matches: prompt (->End)");
			this.sendEvent('end')
			showLine = false;
			return '';
		} //else {
		if(showLine && line.length>0){
			if(isFullLine){
				line = line + '\n';
			}
			this.writeOutput(line, false, fromStderr);
		}
		return line;
	}

	private async handleJson(json: string){
		// handles the json that is printed by .vsc.sendToVsc()
		const j = JSON.parse(json);
		const message = j['message'];
		const body = j['body'];
		const id = j['id'];
		console.log('message ' + id + ': ' + message);
		if(id > this.messageId){
			this.messageId = id;
		}
		if(id === 0){
			this.zeroCounter++;
		} else{
			this.zeroCounter = 0;
		}
		if(this.zeroCounter > 1){
			console.log('warning: many 0 messages!')
			this.zeroCounter = 0;
		}
		switch(message){
			case 'breakpoint':
				this.stdoutIsBrowserInfo = true;
				// this.step();
				this.rSession.runCommand('n');
				this.requestInfoFromR();
				// await this.waitForMessages();
				// this.sendEvent('stopOnBreakpoint');
				this.sendEventOnStack = 'stopOnBreakpoint';
				break;
			case 'error':
				this.stdoutIsBrowserInfo = true;
				this.isCrashed = true;
				// this.requestInfoFromR({isError: true});
				this.requestInfoFromR();
				this.sendEventOnStack = 'stopOnException';
				break;
			case 'end':
				this.isRunningMain = false;
				this.sendEvent('end');
				break;
			case 'go':
				this.isRunningMain = true;
				this.rSession.useQueue = this.useRCommandQueue;
				break;
			case 'stack':
				this.lastStackId = id;
				this.updateStack(body);
				if(this.sendEventOnStack){
					this.sendEvent(this.sendEventOnStack);
					this.sendEventOnStack = '';
				}
				// for error:
				// this.stack['frames'] = this.stack['frames'].slice(3)
				// for(var i = 0; i<this.stack['frames'].length; i++){
				// 	this.stack['frames'][i]['id'] = i+1;
				// }
				//
				break;
			case 'variables':
				if(id >= this.lastStackId){
					this.updateVariables(body);
				}
				break;
			case 'eval':
				const result = body;
				this.sendEvent('evalResponse', result);
				break;
			case 'print':
				const output = body['output'];
				const file = body['file'];
				const line = body['line'];
				this.writeOutput(output, true, false, file, line);
				break;
			case 'noMain':
				vscode.window.showErrorMessage('No main() function found!')
				this.terminate();
				break;
			default:
				console.warn('Unknown message: ' + message);
		}
	}

	// Async function to wait for responses from R
	// waits for this.messageId to catch up with this.requestId
	// this.requestId is incremented by calls to e.g. this.requestInfoFromR()
	// this.messageId is incremented by messages from R that contain an Id>0
	private async waitForMessages(){
		const poll = (resolve: () => void) => {
			if(this.messageId >= this.requestId){
				resolve();
			} else {
				setTimeout(_ => poll(resolve), 100);
			}
		};
		return new Promise(poll);
	}


	private updateStack(stack: any[]){
		try {
			if(stack['frames'][0]['line'] === 0){
				stack['frames'][0]['line'] = this.currentLine;
			}
		} catch(error){}
		this.stack = stack
		this.variables = {};
		this.updateVariables(stack['varLists']);
	}

	private updateVariables(varLists: any[]){
		varLists.forEach(varList => {
			if(varList['isReady']){
				this.variables[varList['reference']] = (varList['variables'] as DebugProtocol.Variable[])
			}
		});
		console.log('updated: variables')
	}

	///////////////////////////////////////////////
	// step-control
	///////////////////////////////////////////////

	private requestInfoFromR(args = {}) {
		// requests info about the stack and workspace from R
		args = {
			...args,
			'id': ++this.requestId,
			'isError': this.isCrashed
		};
		this.rSession.callFunction('.vsc.getStack', args);
		return this.waitForMessages();
	}

	private requestVariablesFromR(refs: number[]){
		const refListForR = 'list(' + refs.join(',') + ')';
		const args = {'refs': refListForR, 'id': ++this.requestId};
		this.rSession.callFunction('.vsc.getVarLists', args);
		return this.waitForMessages();
	}

	// continue script execution:
	public continue(reverse = false) {
		if(this.isCrashed){
			this.terminateFromBrowser();
		} else{
			this.isPaused = false;
			this.rSession.runCommand('c');
		}
	}

	// 1 step:
	public async step(reverse = false, event = 'stopOnStep') {
		if(this.isCrashed){
			this.terminateFromBrowser();
		} else {
			// await this.waitForMessages();
			this.rSession.runCommand('n');
			this.requestInfoFromR();
			await this.waitForMessages();
			this.sendEvent(event);
		}
	}

	// step into function:
	public async stepIn(event = 'stopOnStep') {
		if(this.isCrashed){
			this.terminateFromBrowser();
		} else {
			await this.waitForMessages();
			this.rSession.runCommand('s');
			this.requestInfoFromR();
			await this.waitForMessages();
			this.sendEvent(event);
		}
	}

	// execute rest of function:
	public async stepOut(reverse = false, event = 'stopOnStep') {
		if(this.isCrashed){
			this.terminateFromBrowser();
		} else {
			await this.waitForMessages();
			this.rSession.runCommand('f');
			this.requestInfoFromR();
			this.sendEvent(event);
		}
	}
	
	// forward an expression entered into the debug window to R
	public async evaluate(expr: string, frameId: number | undefined) {
		if(isUndefined(frameId)){
			frameId = 0;
		}
		expr = toRStringLiteral(expr, '"');
		this.rSession.callFunction('.vsc.evalInFrame', [expr, frameId]);
		this.requestInfoFromR();
		// await this.waitForMessages();
	}


	// info for debug session
	public getScopes(frameId: number) {
		// await this.waitForMessages();
		return this.stack['frames'][frameId]['scopes'];
	}

	// public async getVariables(scope: string) {
	public async getVariables(varRef: number) {

		// await this.waitForMessages();
		if(this.variables[varRef]){
			return this.variables[varRef];
		} else{
			this.requestVariablesFromR([varRef]);
			await this.waitForMessages();
			return this.variables[varRef];
		}
	}

	public getStack(startFrame: number, endFrame: number) {
		// await this.waitForMessages();
		return this.stack;
	}

	public getBreakpoints(path: string, line: number): number[] {
		const bps: number[] = [];
		return bps;
	}


	public stack2(startFrame: number, endFrame: number): any {

		// const words = this._sourceLines[this._currentLine].trim().split(/\s+/);
		// const words = ["The", "Mock", "Debug", "Extension"];
		const words = [];

		const frames = new Array<any>();
		// every word of the current line becomes a stack frame.
		for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			const name = words[i];	// use a word of the line as the stackframe name
			frames.push({
				index: i,
				name: `${name}(${i})`,
				file: this.sourceFile,
				line: this.currentLine
			});
		}
		return {
			frames: frames,
			count: words.length
		};
	}


	/*
	 * Set breakpoint in file with given line.
	 */

	public setBreakPoint(path: string, line: number) : DebugBreakpoint {

		const bp = <DebugBreakpoint> { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<DebugBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);


		this.verifyBreakpoints(path); //currently dummy

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : DebugBreakpoint | undefined {
	// 	let bps = this._breakPoints.get(path);
	// 	if (bps) {
	// 		const index = bps.findIndex(bp => bp.line === line);
	// 		if (index >= 0) {
	// 			const bp = bps[index];
	// 			bps.splice(index, 1);
	// 			return bp;
	// 		}
	// 	}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		// if (address) {
		// 	this._breakAddresses.add(address);
		// 	return true;
		// }
		return false;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		// this._breakAddresses.clear();
	}

	public killR(): void {
		this.ignoreOutput = true;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		// this.sendEvent('end');
	}

	public terminateFromBrowser(): void {
		this.ignoreOutput = true;
		this.rSession.clearQueue();
		this.rSession.runCommand('Q', [], true);
		this.sendEvent('end');
	}

	public terminate(): void {
		this.ignoreOutput = true;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		this.sendEvent('end');
	}

	public cancel(): void {
		this.rSession.clearQueue();
	}


	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {}

	private verifyBreakpoints(path: string) : void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			// this.loadSource(path);
			bps.forEach(bp => {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
				// 	}
				// }
			});
		}
	}


	private sendEvent(event: string, ... args: any[]) {
		console.log('event:' + event);
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

}