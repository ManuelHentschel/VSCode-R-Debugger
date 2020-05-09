/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// import { readFileSync, write } from 'fs';
import { EventEmitter } from 'events';
// import { Terminal, window } from 'vscode';
import * as vscode from 'vscode';
import {getRPath, getTerminalPath } from "./utils";
import { TextDecoder, isUndefined } from 'util';

import {toRStringLiteral, RSession} from './rSession';

// import * as debugadapter from 'vscode-debugadapter';

import * as child from 'child_process';

const path = require('path');
export interface DebugBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export class DebugRuntime extends EventEmitter {

	// the initial file we are 'debugging'
	private _sourceFile!: string;
	public get sourceFile() {
		return this._sourceFile;
	}

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentFile = this._sourceFile;

	// maps from sourceFile to array of breakpoints
	private _breakPoints = new Map<string, DebugBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private cp!: child.ChildProcessWithoutNullStreams;
	private rSession!: RSession;

	private hasStartedMain: boolean = false;
	private isRunningMain: boolean = false;
	private isPaused: boolean = false;

	private showUser: boolean = false;

	// used to store text if only part of a line is read form cp.stdout/cp.sterr
	private restOfStdout: string = "";
	private restOfStderr: string = "";

	private stdoutIsBrowserInfo = false; // set to true if cp.stdout is currently giving browser()-details

	private scopes: any = undefined;
	private stack: any = undefined;
	private requestId = 0;
	private messageId = 0;

	// delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// are passed to RegExp() -> need to be escaped 'twice'
	readonly delimiter0 = '<v\\\\s\\\\c>';
	readonly delimiter1 = '</v\\\\s\\\c>';
	readonly rprompt = '<#>';

	constructor() {
		super();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean) {
		this._sourceFile = program;

		// print some info about the rSession
		this.sendEvent('output', 'startCollapsed: Starting R session...');
		this.sendEvent('output',`delimiter0: ${this.delimiter0}\ndelimiter1:${this.delimiter1}\nR-Prompt: ${this.rprompt}`);

		// is set to true, once main() is called in R
		this.isRunningMain = false;
		
		// start R
		// const Rpath = '"C:\\Program Files\\R\\R-3.6.3\\bin\\R.exe"';
		const terminalPath = getTerminalPath();
		const rPath = getRPath();
		const cwd = path.dirname(program);
		const rArgs = ['--ess', '--quiet', '--interactive', '--no-save'];
		this.rSession = new RSession(terminalPath, rPath, cwd, rArgs);


		// load helper functions etc.
		// const fileNamePrep = "prep.R"
		// const fileNamePrep = vscode.workspace.getConfiguration().get<string>('rdebugger.prep.r','');
		// const fileNamePrep = this.prepRPath;
		// this.rSession.callFunction('source', [toRStringLiteral(fileNamePrep)]);
		const packageName = 'vscDebugger'
		this.rSession.callFunction('library', [packageName])

		// source file that is being debugged
		this.rSession.callFunction('source', [toRStringLiteral(program)]);

		// set breakpoints in R
		this._breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
			bps.forEach((bp: DebugBreakpoint) => {
				this.rSession.callFunction('.vsc.mySetBreakpoint', [toRStringLiteral(path), bp.line]);
			});
		});
		
		// handle output from the R-process
		this.rSession.cp.stdout.on("data", data => {
			this.handleData(data);
		});
		this.rSession.cp.stderr.on("data", data => {
			this.handleData(data, true);
		});

		// call main()
		// TODO: replace runMain() with direct main() call?
		this.rSession.callFunction('.vsc.runMain');
		this.sendEvent('output', 'end: ');
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
	
	private handleData(data: any, fromStderr: boolean = false) {
		// handles output from the R child process
		// splits cp.stdout into lines / waits for complete lines
		// calls handleLine() on each line
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
			this.handleLine(lines[i], fromStderr);
		}

		if(lines.length > 0) {
			// calls this.handleLine on the remainder of the last line
			// necessary, since e.g. input prompt (">") does not send a newline
			var remainingText = lines[lines.length - 1];
			// handleLine returns the parts of a line that were not 'understood'
			remainingText = this.handleLine(remainingText, fromStderr, false);
			
			// remember parts that were no understood for next call
			if(fromStderr){
				this.restOfStderr = remainingText;
			} else {
				this.restOfStdout = remainingText;
			}
		}
	}
	

	private handleLine(line: string, fromStderr = false, isFullLine = true): string{
		// handles output-lines from R child process
		// if(this.isRunningMain) {
			var matches: any;
			// onlye show the line to the user if it is complete & relevant
			var showLine = isFullLine && !this.stdoutIsBrowserInfo && this.isRunningMain;
			// var showLine = isFullLine && !this.stdoutIsBrowserInfo;

			var tmpRegex: RegExp;
			const debugRegex = new RegExp(this.delimiter0 + '(.*)' + this.delimiter1);
			const promptRegex = new RegExp(this.rprompt);
			matches = debugRegex.exec(line);
			if(matches){
				// is meant for the debugger, not the user
				this.handleJson(matches[1]);
				line = line.replace(debugRegex, '');
			}

			tmpRegex = /Browse\[\d+\]> /;
			if(tmpRegex.test(line)){
				// R has entered the browser (usually caused by a breakpoint)
				if(!this.isPaused){
					this.isPaused = true;
				}
				line = line.replace(tmpRegex,'');
				showLine = false;
				this.stdoutIsBrowserInfo = false;
			} 
			if(/Called from: (.*)\n/.test(line)){
				// part of browser-info
				showLine = false;
			}
			if(isFullLine && /^[ncsfQ]$/.test(line)) {
				// commands used to control the browser
				console.log('matches: [ncsfQ]');
				showLine = false;
			}
			if(isFullLine && /^\.vsc\./.test(line)) {
				// was a command sent to R by the debugger
				console.log('matches: .vsc');
				showLine = false;
			}
			if(isFullLine && (/debug: /.test(line) ||
					/exiting from: /.test(line) ||
					/debugging in: /.test(line))){
				// is info given by browser()
				showLine = false;
				this.stdoutIsBrowserInfo = true;
			}
			matches = /^debug at (.*)#(\d+): .*$/.exec(line);
			if(matches){
				// is info given by browser()
				this._currentFile = matches[1];
				this._currentLine = parseInt(matches[2]);
				showLine = false;
				this.stdoutIsBrowserInfo = true;
			}
			if(this.isRunningMain && promptRegex.test(line)){
				console.log("matches: <#> (End)");
				this.sendEvent('end')
				showLine = false;
				return '';
			} //else {
			if(showLine && line.length>0){
				if(isFullLine){
					line = line + '\n';
				}
				this.writeOutput(line, fromStderr);
			}
		return line;
	}

	private handleJson(json: string){
		// handles the json that is printed by .vsc.sendToVsc()
		const j = JSON.parse(json);
		const message = j['message'];
		const body = j['body'];
		const id = j['id'];
		console.log('message ' + id + ': ' + message);
		if(id > this.messageId){
			this.messageId = id;
		}
		switch(message){
			case 'breakpoint':
				this.step();
				this.sendEvent('stopOnBreakpoint');
				this.stdoutIsBrowserInfo = true;
				break;
			case 'end':
				this.isRunningMain = false;
				this.sendEvent('end');
				break;
			case 'go':
				this.isRunningMain = true;
				break;
			case 'ls':
				this.scopes = body;
				break;
			case 'stack':
				const stack = body;
				try {
					stack['frames'][0]['line'] = this._currentLine;
				} catch(error){}
				this.stack = stack;
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

	///////////////////////////////////////////////
	// step-control
	///////////////////////////////////////////////

	private requestInfoFromR(): number {
		// requests info about the stack and workspace from R
		// this.rSession.callFunction('.vsc.describeLs2', {'id': ++this.requestId});
		this.rSession.callFunction('.vsc.getStack', {'id': ++this.requestId});
		return(this.requestId);
	}

	// continue script execution:
	public continue(reverse = false) {
		this.isPaused = false;
		this.rSession.runCommand('c');
	}

	// 1 step:
	public step(reverse = false, event = 'stopOnStep') {
		this.rSession.runCommand('n');
		this.requestInfoFromR();
		this.sendEvent(event);
	}

	// step into function:
	public stepIn(event = 'stopOnStep') {
		this.rSession.runCommand('s');
		this.requestInfoFromR();
		this.sendEvent(event);
	}

	// execute rest of function:
	public stepOut(reverse = false, event = 'stopOnStep') {
		this.rSession.runCommand('f');
		this.requestInfoFromR();
		this.sendEvent(event);
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
	public async getScopes(frameId: number) {
		await this.waitForMessages();
		return this.stack['frames'][frameId-1]['scopes'];
	}

	// public async getVariables(scope: string) {
	public async getVariables(varRef: number) {
		await this.waitForMessages();

		return this.stack['varLists'][varRef-1];
	}

	public async getStack(startFrame: number, endFrame: number) {
		await this.waitForMessages();
		return this.stack;
	}

	public getBreakpoints(path: string, line: number): number[] {
		const bps: number[] = [];
		return bps;
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

	public cancel(): void {
		this.cp.kill();
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
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}