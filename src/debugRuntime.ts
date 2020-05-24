/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// import { readFileSync, write } from 'fs';
import { EventEmitter } from 'events';
// import { Terminal, window } from 'vscode';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import {getRPath, getTerminalPath, escapeForRegex, toRStringLiteral } from "./utils";
import { TextDecoder, isUndefined } from 'util';

import { RSession, makeFunctionCall } from './rSession';
import { DebugProtocol } from 'vscode-debugprotocol';


const path = require('path');
export interface DebugBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}


export class DebugRuntime extends EventEmitter {

	// delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// need to match those used in the R-package
	// TODO: replace with a dedicated pipe between R and vsc?
	readonly delimiter0 = '<v\\s\\c>';
	readonly delimiter1 = '</v\\s\\c>';
	readonly rprompt = '<#v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rStartup = '<v\\s\\c\\R\\STARTUP>'
	readonly libraryNotFoundString = '<v\\s\\c\\LIBRARY\\NOT\\FOUND>';
	readonly packageName = 'vscDebugger';

	// The file we are debugging
	private sourceFile: string;

	// The current line
	private currentLine = 0;

	// maps from sourceFile to array of breakpoints
	// TODO: rework breakpoints entirely
	private breakPoints = new Map<string, DebugBreakpoint[]>();

	// debugging
	private logLevel = 3;

	// The rSession used to run the code
	private rSession: RSession;

	// Whether to use a queue for R commands (makes debugging slower but 'safer')
	private useRCommandQueue: boolean = true;

	// Time in ms to wait before sending an R command (makes debugging slower but 'safer')
	private waitBetweenRCommands: number = 0;

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private breakpointId = 1;

	// possible states of the R session
	private isReady: boolean = false; // is set to true after executing the first R command successfully
	private isRunningMain: boolean = false; // is set to true after receiving a message 'go'
	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details
	private isCrashed: boolean = false; // is set to true upon encountering an error (in R)
	private ignoreOutput: boolean = false; // is set to true after terminating the session
	private expectBrowser: boolean = false;

	// used to store text if only part of a line is read form cp.stdout/cp.sterr
	private restOfStdout: string = "";
	private restOfStderr: string = "";

	// info about the R stack, variables etc.
	private stack: any = undefined; //TODO specify type!
	private variables: Record<number, DebugProtocol.Variable[]> = {}; // stores info about variables of the R process
	private requestId = 0; // id of the last function call made to R (not all function calls need to be numbered)
	private messageId = 0; // id of the last function call response received from R (only updated if larger than the previous)
	private lastStackId = 0; // id of the last stack-message received from R
	private sendEventOnStack: string = ''; // send this event upon receiving the next Stack-message

	// debugMode
	private mainFunction: string = 'main';
	private allowDebugGlobal: boolean = false;
	private debugMode: ('function'|'global');
	private tmpDebugMode: ('function'|'global');


	////////////////////////////////////////////////////
	// METHODS
	////////////////////////////////////////////////////

	// constructor
	constructor() {
		super();
		this.allowDebugGlobal = true;
		this.debugMode = 'global';
		this.tmpDebugMode = 'global';
	}

	// start
	public async start(program: string) {
		// set sourcefile
		this.sourceFile = program;
		
		// read settings from vsc-settings
		const config = workspace.getConfiguration('rdebugger');
		this.useRCommandQueue = config.get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config.get<number>('waitBetweenRCommands', 0);

		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		// group ends by outputting 'end: '
		this.sendEvent('output', 'startCollapsed: Starting R session...');
		this.sendEvent('output',`delimiter0: ${this.delimiter0}\ndelimiter1:${this.delimiter1}\nR-Prompt: ${this.rprompt}`);

		// start R in child process
		const terminalPath = getTerminalPath(); // read OS-specific terminal path from config
		const rPath = getRPath(); // read OS-specific R path from config
		const cwd = path.dirname(program);
		// essential R args: --interactive (linux) and --ess (windows) to force an interactive session:
		const rArgs = ['--ess', '--quiet', '--interactive', '--no-save']; 

		this.sendEvent('output', 'terminalPath: ' + terminalPath + '\ncwd: ' + cwd + '\nrPath: ' + rPath + '\nrArgs: ' + rArgs.join(' '))
		this.rSession = new RSession(terminalPath, rPath, cwd, rArgs);
		this.rSession.waitBetweenCommands = this.waitBetweenRCommands;
		if(!this.rSession.successTerminal){
            vscode.window.showErrorMessage('Terminal path not working:\n' + terminalPath);
			this.terminate();
			return;
		}
		
		// handle output from the R-process
		this.rSession.cp.stdout.on("data", data => {
			this.handleData(data, false);
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
		// the timeout resolves to false, this.waitForR() resolves to true
		const successR = await Promise.race([timeout, this.waitForR()])

		// abort if the terminal does not print the message (--> R has not started!)
		if(!successR){
            vscode.window.showErrorMessage('R path not working:\n' + rPath);
			this.terminate();
			return;
		}

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleData()
		this.sendEvent('output', 'library: ' + this.packageName);
		const libraryCommandArgs = {
			expr: makeFunctionCall('library', this.packageName, [], 'base'),
			error: 'function(e){' + makeFunctionCall('cat', toRStringLiteral(this.libraryNotFoundString), toRStringLiteral('\n'), 'base') + '}',
			silent: true
		}
		this.rSession.callFunction('tryCatch', libraryCommandArgs, [], 'base')

		if(this.debugMode === 'function'){
			// source file that is being debugged
			this.sendEvent('output', 'program: ' + program)
			this.rSession.callFunction('source', [toRStringLiteral(program)], [], 'base');
		}

		// all R function calls from here on are meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.packageName;

		if(this.debugMode === 'function'){
			// set breakpoints in R
			const setBreakPointsInPackages = config.get<boolean>('setBreakpointsInPackages', false)
			this.breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
				const lines = bps.map(bp => bp.line)
				const ids = bps.map(bp => bp.id)
				const rArgs = {
					srcfile: toRStringLiteral(path),
					lines: 'list(' + lines.join(',') + ')',
					includePackages: setBreakPointsInPackages,
					ids: 'list(' + ids.join(',') + ')'
				}
				this.rSession.callFunction('.vsc.setBreakpoint', rArgs)
				// bps.forEach((bp: DebugBreakpoint) => {
					// this.rSession.callFunction('.vsc.mySetBreakpoint', [toRStringLiteral(path), bp.line]);
				// });
			});
		}


		const options = {
			overwritePrint: config.get<boolean>('overwritePrint', false),
			overwriteCat: config.get<boolean>('overwriteCat', false),
			findMain: (this.debugMode == 'function'),
			mainFunction: toRStringLiteral(this.mainFunction),
			debugGlobal: this.allowDebugGlobal
		}

		// if(this.debugMode === 'function'){
		// 	// call .vsc.runMain, which looks for a main() function in the .GlobalEnv
		// 	// in case main() is missing, it is reported by the R-package and handled by this.handleData()
		// 	this.rSession.callFunction('.vsc.runMain', options);
		// }

		// if(this.debugMode === 'global'){
		// 	this.requestInfoFromR();
		// 	this.sendEventOnStack = 'stopOnBreakpoint'
		// }

		this.rSession.callFunction('.vsc.prepGlobalEnv', options);



		this.sendEvent('output', 'end: '); // end info group
	}

	// async method to wait for R to be ready
	// needs to be raced against a timeout to avoid stalling the application
	private async waitForR(){
		const poll = (resolve: (boolean) => void) => {
			if(this.isReady){
				resolve(true);
			} else {
				setTimeout(_ => poll(resolve), 100);
			}
		};
		return new Promise(poll);
	}

	// send event to the debugSession
	private sendEvent(event: string, ... args: any[]) {
		console.log('event:' + event);
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	private writeOutput(text: any, addNewline = false, toStderr = false, filePath = '', line = 1){
		// writes output to the debug console (of the vsc instance runnning the R code)
		if(text.slice(-1) !== '\n' && addNewline){
			text = text + '\n';
		}

		const category = (toStderr ? "stderr" : "stdout");
		this.sendEvent("output", text, category, filePath, line);
	}


	//////////
	// Output-handlers: (for output of the R process to stdout/stderr)
	//////////
	
	private async handleData(data: any, fromStderr: boolean = false) {
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
			// abort output handling if ignoreOutput has been set to true
			// used to avoid handling remaining output after debugging has been stopped
			if(this.ignoreOutput){
				return;
			}
			await this.handleLine(lines[i], fromStderr);
		}

		if(lines.length > 0) {
			// abort output handling if ignoreOutput has been set to true
			if(this.ignoreOutput){
				return;
			}

			// calls this.handleLine on the remainder of the last line
			// necessary, since e.g. an input prompt does not send a newline
			// handleLine returns the parts of a line that were not 'understood'
			const remainingText = await this.handleLine(lines[lines.length - 1], fromStderr, false);
			
			// remember parts that were no understood for next call
			if(fromStderr){
				this.restOfStderr = remainingText;
			} else {
				this.restOfStdout = remainingText;
			}
		}
	}
	

	private async handleLine(line: string, fromStderr = false, isFullLine = true) {
		// handle output from the R process line by line
		// is called by this.handleData()

		// onlye show the line to the user if it is complete & relevant
		var showLine = isFullLine && !this.stdoutIsBrowserInfo && this.isRunningMain;

		// temp variables for regexes and matches
		var tmpRegex: RegExp;
		var tmpMatches: any;
		
		// regex to identify info meant for vsc
		const debugRegex = new RegExp(escapeForRegex(this.delimiter0) + '(.*)' + escapeForRegex(this.delimiter1));

		// filter out info meant for vsc:
		tmpMatches = debugRegex.exec(line);
		if(tmpMatches){
			// is meant for the debugger, not the user
			await this.handleJson(tmpMatches[1]);
			line = line.replace(debugRegex, '');
		}

		// Check for R-Startup message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.rStartup)).test(line)){
			this.isReady = true;
		}

		// Check for Library-Not-Found-Message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.libraryNotFoundString)).test(line)){
			console.error('R-Library not found!');
			vscode.window.showErrorMessage('Please install the R package "' + this.packageName + '"!');
			this.terminate();
		}

		// read info about the browser/debugger
		if(/Tracing (.*)step \d+/.test(line)){
			showLine = false;
			this.hitBreakpoint()
		}
		tmpRegex = /Browse\[\d+\]> /;
		if(tmpRegex.test(line)){
			// R has entered the browser (usually caused by a breakpoint or step)
			line = line.replace(tmpRegex,'');
			showLine = false;
			// this.stdoutIsBrowserInfo is set to true by a message to vsc with message 'breakpoint'
			this.stdoutIsBrowserInfo = false; // input prompt is last part of browser-info
			if(!this.expectBrowser){
				// unexpected breakpoint:
				this.hitUnexpectedBreakpoint();
			}
			
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
			// this.currentFile = tmpMatches[1];
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
		tmpRegex = new RegExp(this.packageName + '::')
		if(isFullLine && tmpRegex.test(line)) {
			// was a command sent to R by the debugger
			console.log('matches: vscDebugger::');
			showLine = false;
		}

		// check for prompt
		const promptRegex = new RegExp(escapeForRegex(this.rprompt));
		if(promptRegex.test(line) && isFullLine){
			console.log("matches: prompt (->End)");
			if(this.allowDebugGlobal){
				this.tmpDebugMode = 'global';
				this.rSession.showsPrompt();
			} else if(this.isRunningMain){
				this.sendEvent('end')
			}
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
		// is called by this.handleLine() if the line contains a json enclosed by this.delimiter0 and this.delimiter1
		const j = JSON.parse(json);
		const message = j['message'];
		const body = j['body'];
		const id = j['id'];
		console.log('message ' + id + ': ' + message);

		// update Id of latest message
		// requests are handled sequentially by R --> no need to check fro previous message Ids
		// use max() since unrequested are sent with id=0
		this.messageId = Math.max(this.messageId, id)

		switch(message){
			case 'breakpoint':
				// should not occurr anymore
				this.hitBreakpoint();
				break;
			case 'breakpointVerification':
				const bp = body;
				this.sendEvent('breakpointValidated', bp);
				break;
			case 'lineAtBreakpoint':
				if(body>0){
					this.currentLine = body.line;
				}
				break;
			case 'error':
				this.stdoutIsBrowserInfo = true;
				this.isCrashed = true;
				this.requestInfoFromR();
				// event is sent after receiving stack from R in order to answer stack-request synchrnously:
				// (apparently required by vsc?)
				this.sendEventOnStack = 'stopOnException';
				break;
			case 'end':
				this.terminate();
				break;
			case 'go':
				this.isRunningMain = true;
				this.sendEventOnStack = 'stopOnBreakpoint';
				this.rSession.useQueue = this.useRCommandQueue;
				this.requestInfoFromR();
				break;
			case 'callMain':
				this.isRunningMain = true;
				this.rSession.useQueue = this.useRCommandQueue;
				this.rSession.callFunction(this.mainFunction);
				break;
			case 'stack':
				this.lastStackId = id;
				this.updateStack(body);
				if(this.sendEventOnStack){
					this.sendEvent(this.sendEventOnStack);
					this.sendEventOnStack = '';
				}
				break;
			case 'variables':
				if(id >= this.lastStackId){
					this.updateVariables(body);
				}
				break;
			case 'eval':
				const result = body;
				this.sendEvent('evalResponse', result);
				// relies on fast execution by R (--> only one evalResponse outstanding at any time)
				break;
			case 'print':
				// also used by .vsc.cat()
				const output = body['output'];
				const file = body['file'];
				const line = body['line'];
				this.writeOutput(output, true, false, file, line);
				break;
			case 'noMain':
				// is sent by .vsc.runMain() if no main() is found
				vscode.window.showErrorMessage('No main() function found in .GlobalEnv!')
				this.terminate();
				break;
			case 'acknowledge':
				// ignore, just update this.messageId
				break;
			default:
				console.warn('Unknown message: ' + message);
		}
	}

	private hitBreakpoint(){
		this.stdoutIsBrowserInfo = true;
		this.expectBrowser = true;
		this.tmpDebugMode = 'function';
		this.rSession.callFunction('.vsc.getLineAtBreakpoint')
		this.rSession.runCommand('n');
		this.requestInfoFromR();
		// event is sent after receiving stack from R in order to answer stack-request synchronously:
		// (apparently required by vsc?)
		this.sendEventOnStack = 'stopOnBreakpoint';
	}

	private hitUnexpectedBreakpoint(){
		this.stdoutIsBrowserInfo = false;
		this.expectBrowser = true;
		this.tmpDebugMode = 'function';
		this.rSession.callFunction('.vsc.getLineAtBrowser');
		this.requestInfoFromR();
		this.sendEventOnStack = 'stopOnBreakpoint';
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


	// handle new stack info
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

	// handle new variable info
	private updateVariables(varLists: any[]){
		varLists.forEach(varList => {
			if(varList['isReady']){
				this.variables[varList['reference']] = (varList['variables'] as DebugProtocol.Variable[])
			}
		});
		console.log('updated: variables')
	}

	// request info about the stack and workspace from R:
	private requestInfoFromR(args = {}) {
		args = {
			...args,
			'id': ++this.requestId,
			'isError': this.isCrashed
		};
		this.rSession.callFunction('.vsc.getStack', args);
		return this.waitForMessages();
	}

	// request info about specific variables from R:
	private requestVariablesFromR(refs: number[]){
		const refListForR = 'list(' + refs.join(',') + ')';
		const args = {'refs': refListForR, 'id': ++this.requestId};
		this.rSession.callFunction('.vsc.getVarLists', args);
		return this.waitForMessages();
	}


	///////////////////////////////////////////////
	// step-control
	///////////////////////////////////////////////

	// continue script execution:
	public continue(reverse = false) {
		if(this.isCrashed){
			this.terminateFromBrowser();
		} else{
			this.expectBrowser = false;
			this.rSession.runCommand('c');
		}
	}

	// step:
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
	public async evaluate(expr: string, frameId: number | undefined, context: string|undefined) {
		if(this.tmpDebugMode==='function'){
			var silent: boolean = false;
			if(context==='watch'){
				silent = true;
			}
			if(isUndefined(frameId)){
				frameId = 0;
			}
			expr = toRStringLiteral(expr, '"');
			this.rSession.callFunction('.vsc.evalInFrame', {expr: expr, frameId: frameId, silent: silent});
		} else{
			this.rSession.runCommand(expr)
			this.sendEvent('evalResponse', []);
		}
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
		// can be returned synchronously since step-events are sent only after receiving stack info
		return this.stack;
	}

	public getBreakpoints(path: string, line: number): number[] {
		// dummy
		const bps: number[] = [];
		return bps;
	}



	////////////////////////////
	// breakpoint control
	public setBreakPoint(path: string, line: number) : DebugBreakpoint {

		const bp = <DebugBreakpoint> { verified: false, line, id: this.breakpointId++ };
		let bps = this.breakPoints.get(path);
		if (!bps) {
			bps = new Array<DebugBreakpoint>();
			this.breakPoints.set(path, bps);
		}
		bps.push(bp);


		// this.verifyBreakpoints(path); //currently dummy

		return bp;
	}


	private verifyBreakpoints(path: string) : void {
		// dummy
		let bps = this.breakPoints.get(path);
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

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : DebugBreakpoint | undefined {
		// dummy
		return undefined;
	}

	public clearBreakpoints(path: string): void {
		this.breakPoints.delete(path);
	}

	public setDataBreakpoint(address: string): boolean {
		// dummy
		return false;
	}

	public clearAllDataBreakpoints(): void {
		// dummy
	}



	///////////////////////////////
	// functions to terminate the debug session

	public killR(): void {
		this.ignoreOutput = true;
		this.isRunningMain = false;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		// this.sendEvent('end');
	}

	public terminateFromBrowser(): void {
		this.ignoreOutput = true;
		this.isRunningMain = false;
		this.rSession.clearQueue();
		this.rSession.runCommand('Q', [], true);
		this.sendEvent('end');
	}

	public terminate(): void {
		this.ignoreOutput = true;
		this.isRunningMain = false;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		this.sendEvent('end');
	}

	public cancel(): void {
		this.rSession.clearQueue();
	}
}