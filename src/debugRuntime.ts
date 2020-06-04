/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// import { readFileSync, write } from 'fs';
import { EventEmitter } from 'events';
// import { Terminal, window } from 'vscode';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { config, getRPath, escapeForRegex } from "./utils";
import { isUndefined } from 'util';

import { RSession, makeFunctionCall, anyRArgs, escapeStringForR } from './rSession';
import { DebugProtocol } from 'vscode-debugprotocol';
import { maxHeaderSize } from 'http';

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
	readonly rDelimiter0 = '<v\\s\\c>';
	readonly rDelimiter1 = '</v\\s\\c>';
	readonly rPrompt = '<#v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rContinue = '<##v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rStartup = '<v\\s\\c\\R\\STARTUP>';
	readonly rLibraryNotFound = '<v\\s\\c\\LIBRARY\\NOT\\FOUND>';
	readonly rPackageName = 'vscDebugger';
	readonly rAppend = ' ### <v\\s\\c\\COMMAND>';

	// The file we are debugging
	private sourceFile: string;

	// the directory in which to run the file
	private cwd: string;

	// The current line
	private currentLine = 0;
	private currentFile = ''; //might be different from sourceFile

	// maps from sourceFile to array of breakpoints
	private breakPoints = new Map<string, DebugBreakpoint[]>();
	public breakOnErrorFromFile: boolean = true;
	public breakOnErrorFromConsole: boolean = false;

	// debugging
	private logLevel = 3;

	// The rSession used to run the code
	private rSession: RSession;
	// Whether to use a queue for R commands (makes debugging slower but 'safer')
	private useRCommandQueue: boolean = true;
	// Time in ms to wait before sending an R command (makes debugging slower but 'safer')
	private waitBetweenRCommands: number = 0;

	// whether to show package environments
	private includePackages: boolean = false;

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private breakpointId = 1;

	// state info about the R session
	private hasStartedR: boolean = false; // is set to true after executing the first R command successfully
	private isRunningCustomCode: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details
	private isCrashed: boolean = false; // is set to true upon encountering an error (in R)
	private expectBrowser: boolean = false; // is set to true if a known breakpoint is encountered (indicated by "tracing...")
	private outputGroupLevel: number = 0; // counts the nesting level of output to the debug window

	// info about the R stack, variables etc.
	private stack: any = undefined; //TODO specify type!
	private variables: Record<number, DebugProtocol.Variable[]> = {}; // stores info about variables of the R process
	private requestId = 0; // id of the last function call made to R (not all function calls need to be numbered)
	private messageId = 0; // id of the last function call response received from R (only updated if larger than the previous)
	private lastStackId = 0; // id of the last stack-message received from R
	private sendEventOnStack: string = ''; // send this event upon receiving the next Stack-message

	// debugMode
	private callMain: boolean = false;
	private mainFunction: string = 'main';
	private callSource: boolean = false;
	private allowDebugGlobal: boolean = false;
	private debugMode: ('function'|'global') = 'function';
	private setBreakpointsInPackages: boolean = false;


	// constructor
	constructor() {
		super();
	}

	// start
	// public async start(program: string, allowDebugGlobal: boolean=true, callMain: boolean=false, mainFunction: string='main') {
	public async start(debugFunction: boolean, debugFile: boolean, allowGlobalDebugging: boolean, workingDirectory: string, program?: string, mainFunction?: string, includePackages: boolean = false) {

		// STORE LAUNCH CONFIG TO PROPERTIES
		this.callMain = debugFunction;
		this.callSource = debugFile;
		this.allowDebugGlobal = allowGlobalDebugging;
		this.cwd = workingDirectory;
		this.sourceFile = program;
		this.mainFunction = mainFunction;

		if(this.callMain){
			this.debugMode = 'function';
		} else{
			this.debugMode = 'global';
		}

		// LAUNCH R PROCESS

		// read settings from vsc-settings
		this.useRCommandQueue = config().get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config().get<number>('waitBetweenRCommands', 0);
		this.includePackages = config().get<boolean>('includePackageScopes', false);

		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		this.startOutputGroup('Starting R session...', true);
		this.writeOutput(''
			+ 'rDelimiter0: ' + this.rDelimiter0
			+ '\nrDelimiter1: ' + this.rDelimiter1
			+ '\nrPrompt: ' + this.rPrompt
			+ '\nrContinue: ' + this.rContinue
			+ '\nrStartup: ' + this.rStartup
			+ '\nrLibraryNotFound: ' + this.rLibraryNotFound
		);

		// start R in child process
		const rPath = await getRPath(); // read OS-specific R path from config
		const cwd = this.cwd;
		const rArgs = ['--ess', '--quiet', '--interactive', '--no-save']; 
		// (essential R args: --interactive (linux) and --ess (windows) to force an interactive session)

		this.writeOutput(''
			+ 'cwd: ' + cwd
			+ '\nrPath: ' + rPath
			+ '\nrArgs: ' + rArgs.join(' ')
		);

		const thisDebugRuntime = this; // direct callback to this.handleLine() does not seem to work...
		this.rSession = new RSession(rPath, cwd, rArgs, thisDebugRuntime);
		this.rSession.waitBetweenCommands = this.waitBetweenRCommands;
		if(!this.rSession.successTerminal){
            vscode.window.showErrorMessage('Failed to spawn a child process!');
			this.terminate();
			return;
		}


		// CHECK IF R HAS STARTED

		// cat message from R
		this.rSession.callFunction('cat', this.rStartup, '\n', true, 'base');

		// set timeout
		const ms = 1000;
		let timeout = new Promise((resolve, reject) => {
			let id = setTimeout(() => {
			clearTimeout(id);
			resolve(false);
			}, ms);
		});

		// wait for message from R (or for the timeout)
		// the timeout resolves to false, this.waitForR() resolves to true
		const successR = await Promise.race([timeout, this.waitForR()]);

		// abort if the terminal does not print the message (--> R has not started!)
		if(!successR){
            vscode.window.showErrorMessage('R path not working:\n' + rPath);
			this.terminate();
			return;
		}


		// LOAD R PACKAGE

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleLine()
		this.writeOutput('library: ' + this.rPackageName);
		const tryCatchArgs: anyRArgs = {
			expr: makeFunctionCall('library', this.rPackageName, [], false, 'base'),
			error: 'function(e)' + makeFunctionCall('cat', this.rLibraryNotFound, '\n', true, 'base'),
			silent: true
		};
		this.rSession.callFunction('tryCatch', tryCatchArgs, [], false, 'base');

		// all R function calls from here on are (by default) meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.rPackageName;
		this.rSession.defaultAppend = this.rAppend;


		// PREP R SESSION AND SOURCE MAIN

		// get config about overwriting R functions
		const overwritePrint = config().get<boolean>('overwritePrint', false);
		const overwriteCat = config().get<boolean>('overwriteCat', false);
		const overwriteSource = config().get<boolean>('overwriteSource', false);

		// prep r session
		const options = {
			overwritePrint: overwritePrint,
			overwriteCat: overwriteCat,
			overwriteSource: overwriteSource,
			findMain: this.callMain,
			mainFunction:this.mainFunction,
			debugGlobal: this.allowDebugGlobal
		};
		this.writeOutput(''
			+ 'overwrite print(): ' + overwritePrint
			+ '\noverwrite cat(): ' + overwriteCat
			+ '\noverwrite source(): ' + overwriteSource
			+ '\nallow global debugging: ' + this.allowDebugGlobal
		);
		this.rSession.callFunction('.vsc.prepGlobalEnv', options);

		if(this.callSource){
			// debug-source the specified file
			this.writeOutput(''
				+ 'program: ' + program
			);
		}

		if(this.callMain){
			// source file that is being debugged
			this.writeOutput(''
				+ 'program: ' + program
				+ '\nmain function: ' + this.mainFunction + '()'
			);
			this.rSession.callFunction('source', program, [], true, 'base');
			this.rSession.callFunction('.vsc.lookForMain', this.mainFunction);
			this.setAllBreakpoints();
			// actual call to main()/error if no main() found is made as response to message 'callMain'
		}

		this.setBreakpointsInPackages = config().get<boolean>('setBreakpointsInPackages', false);

		this.endOutputGroup(); // ends the collapsed output group containing config data, R path, etc.
	}


	// async method to wait for R to start up
	// needs to be raced against a timeout to avoid stalling the application
	// this.hasStartedR is set to true by this.handleLine()
	private async waitForR(){
		const poll = (resolve: (boolean) => void) => {
			if(this.hasStartedR){
				resolve(true);
			} else {
				setTimeout(_ => poll(resolve), 100);
			}
		};
		return new Promise(poll);
	}







	//////////
	// Output-handlers: (for output of the R process to stdout/stderr)
	//////////

	public async handleLine(line: string, fromStderr = false, isFullLine = true) {
		// handle output from the R process line by line
		// is called by rSession.handleData()


		// only show the line to the user if it is complete & relevant
		var showLine = isFullLine && !this.stdoutIsBrowserInfo && this.isRunningCustomCode;

		// filter out info meant for vsc:
		const jsonRegex = new RegExp(escapeForRegex(this.rDelimiter0) + '(.*)' + escapeForRegex(this.rDelimiter1) + '$');
		const jsonMatch = jsonRegex.exec(line);
		if(jsonMatch && isFullLine){
			// is meant for the debugger, not the user
			this.handleJson(jsonMatch[1]);
			line = line.replace(jsonRegex, '');
		}


		// Check for R-Startup message
		if(!this.isRunningCustomCode && RegExp(escapeForRegex(this.rStartup)).test(line)){
			this.hasStartedR = true;
		}
		// Check for Library-Not-Found-Message
		if(!this.isRunningCustomCode && RegExp(escapeForRegex(this.rLibraryNotFound)).test(line)){
			console.error('R-Library not found!');
			vscode.window.showErrorMessage('Please install the R package "' + this.rPackageName + '"!');
			this.terminate();
		}


		// Breakpoints set with trace() or vscDebugger::mySetBreakpoint() are preceded by this:
		if(isFullLine && /Tracing (.*)step/.test(line)){
			showLine = false;
			this.stdoutIsBrowserInfo = true;
			this.expectBrowser = true;
			this.hitBreakpoint(true);
		}

		// filter out additional browser info:
		if(isFullLine && (/(?:debug|exiting from|debugging|Called from|debug at) /.test(line))){
			showLine = false; // part of browser-info
			this.stdoutIsBrowserInfo = true;
		}

		// Check for browser prompt
		const browserRegex = /Browse\[\d+\]> /;
		if(browserRegex.test(line)){
			// R has entered the browser
			line = line.replace(browserRegex,'');
			showLine = false;
			this.stdoutIsBrowserInfo = false; // input prompt is last part of browser-info
			if(!this.expectBrowser){
				// unexpected breakpoint:
				this.hitBreakpoint(false);
			}
			console.log('matches: browser prompt');
			this.rSession.showsPrompt();
		} 


		// identify echo of browser commands sent by vsc
		if(isFullLine && /^[ncsfQ]$/.test(line)) {
			// commands used to control the browser
			console.log('matches: [ncsfQ]');
			showLine = false;
		}

		// matches echo of calls made by the debugger
		const echoRegex = new RegExp(escapeForRegex(this.rAppend) + '$');
		if(isFullLine && echoRegex.test(line)){
			showLine = false;
			console.log('matches: echo');
		}


		// check for prompt
		const promptRegex = new RegExp(escapeForRegex(this.rPrompt));
		if(promptRegex.test(line) && isFullLine){
			console.log("matches: prompt");
			if(this.allowDebugGlobal){
				if(this.debugMode === 'function'){
					this.sendEventOnStack = 'stopOnEntry';
					this.requestInfoFromR();
					this.debugMode = 'global';
				}
				this.endOutputGroup();
				this.rSession.showsPrompt();
				this.expectBrowser = false;
			} else if(this.isRunningCustomCode){
				// this.sendEvent('end');
			}
			showLine = false;
			return '';
		}

		// check for continue prompt
		const continueRegex = new RegExp(escapeForRegex(this.rContinue));
		if(continueRegex.test(line) && isFullLine){
			console.log("matches: continue prompt");
			showLine = false;
		}

		// check for StdErr (show everything):
		if(fromStderr){
			showLine = true;
		}

		// output any part of the line that was not parsed
		if(showLine && line.length>0){
			this.writeOutput(line, isFullLine, fromStderr);
			line = '';
		}
		return line;
	}



	private async handleJson(json: string){
		// handles the json that is printed by .vsc.sendToVsc()
		// is called by this.handleLine() if the line contains a json enclosed by this.delimiter0 and this.delimiter1
		// TODO: send json via separate pipe?

		// jsons are of the form: {message: string; body: any; id: number}
		const j = JSON.parse(json);
		const message = j['message'];
		const body = j['body'];
		const id = j['id'];
		console.log('message (#' + id + '): ' + message);
		console.log(body);

		// update Id of latest message
		// requests are handled sequentially by R --> no need to check for previous message Ids
		// use max() since unrequested messages are sent with id=0
		this.messageId = Math.max(this.messageId, id);

		switch(message){
			case 'breakpointVerification':
				// sent to report back after trying to set a breakpoint
				const bp = body;
				this.sendEvent('breakpointValidated', bp);
				break;
			case 'error':
				// sent if an error was encountered by R and 
				this.stdoutIsBrowserInfo = true;
				this.isCrashed = true;
				this.expectBrowser = true;
				this.debugMode = 'function';
				this.sendEventOnStack = '';
				await this.requestInfoFromR();
				// event is sent after receiving stack from R in order to answer stack-request synchronously:
				// (apparently required by vsc?)
				// this.sendEventOnStack = 'stopOnException';
				this.sendEvent('stopOnException', body);
				break;
			case 'end':
				// can be sent e.g. after completing main()
				this.terminate();
				break;
			case 'stack':
				// contains info about the entire stack and some variables. requested by the debugger on each step
				this.lastStackId = id;
				this.updateStack(body);
				if(this.sendEventOnStack){
					this.sendEvent(this.sendEventOnStack);
					this.sendEventOnStack = '';
				}
				break;
			case 'variables':
				// contains info about single variables, requested by the debugger
				if(id >= this.lastStackId){
					this.updateVariables(body);
				}
				break;
			case 'eval':
				// contains the result of an evalRequest sent by the debugger
				const result = body;
				await this.waitForMessages(); //make sure that stack info is received
				this.sendEvent('evalResponse', result, id);
				break;
			case 'print':
				// also used by .vsc.cat()
				const output = body['output'];
				const file = body['file'];
				const line = body['line'];
				this.writeOutput(output, true, false, file, line);
				break;
			case 'completion':
				this.sendEvent('completionResponse', body);
				break;
			case 'go':
				// is sent by .vsc.prepGlobalEnv() to indicate that R is ready for .vsc.debugSource()
				this.isRunningCustomCode = true;
				this.rSession.useQueue = this.useRCommandQueue;
				if(this.callSource){
					this.debugSource(this.sourceFile);
				} else if(this.debugMode === 'global'){
					this.requestInfoFromR();
					this.sendEventOnStack = 'stopOnEntry';
				}
				break;
			case 'callMain':
				// is sent by .vsc.prepGlobalEnv() to indicate that main() was found
				this.rSession.useQueue = this.useRCommandQueue;
				this.setAllBreakpoints();
				this.rSession.callFunction('.vsc.sendToVsc', 'nextCallIsMain');
				this.rSession.callFunction(this.mainFunction,[],[],false,'');
				this.isRunningCustomCode = true;
				break;
			case 'noMain':
				// is sent by .vsc.prepGlobalEnv() if no main() is found
				vscode.window.showErrorMessage('No ' + this.mainFunction + '() function found in .GlobalEnv!');
				this.terminate();
				break;
			case 'acknowledge':
				// ignore, just update this.messageId
				break;
			default:
				console.warn('Unknown message: ' + message);
		}
	}



	//////////////////////////////////////////////
	// OUTPUT

	// send event to the debugSession
	private sendEvent(event: string, ... args: any[]) {
		console.log('event:' + event);
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	private writeOutput(text: string, addNewline = false, toStderr = false, filePath = '', line = 1, group?: ("start"|"startCollapsed"|"end")){
		// writes output to the debug console (of the vsc instance runnning the R code)
		if(text.slice(-1) !== '\n' && addNewline){
			text = text + '\n';
		}
		var doSendEvent: boolean = true;
		if(group==='start' || group==='startCollapsed'){
			this.outputGroupLevel += 1;
		} else if(group==='end'){
			if(this.outputGroupLevel>0){
				this.outputGroupLevel -= 1;
			} else{
				doSendEvent = false;
			}
		}
		if(doSendEvent){
			const category = (toStderr ? "stderr" : "stdout");
			const column = 1;
			this.sendEvent("output", text, category, filePath, line, column, group);
		}
	}
	private startOutputGroup(text: string = "", collapsed: boolean = false, addNewline = false, toStderr = false, filePath = '', line = 1){
		var group: ("start"|"startCollapsed");
		if(collapsed){
			group = "startCollapsed";
		} else{
			group = "start";
		}
		this.writeOutput(text, addNewline, toStderr, filePath, line, group);
	}
	private endOutputGroup(){
		this.writeOutput("", false, false, '', 1, "end");
	}

	private hitBreakpoint(expected: boolean = true){
		this.expectBrowser = true; //indicates that following browser statements are no 'new' breakpoint
		this.debugMode = 'function'; //browser is only called from inside a function/evaluated expression
		if(expected){
			// is sent BEFORE parsing all the browserInfo
			this.stdoutIsBrowserInfo = true; 
			// sent if the breakpoint was set by the debugger -> skip the browser() statement
			this.rSession.clearQueue();
			this.rSession.runCommand('n');
		} else{
			// unexpected breakpoint --> browser() statement is part of the actual source code
			this.rSession.clearQueue();
		}
		// request stack
		this.requestInfoFromR();
		// event is sent after receiving stack from R in order to answer stack-request synchronously:
		// (apparently required by vsc?)
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



	/////////////////////////////////////////////////
	// STACK / VARIABLES

	// handle new stack info
	private updateStack(stack: any[]){
		try {
			if(stack['frames'][0]['line'] === 0){
				// stack['frames'][0]['line'] = this.currentLine;
			}
		} catch(error){}
		try {
			if(stack['frames'][0]['file'] === 0){
				// stack['frames'][0]['file'] = this.currentFile;
			}
		} catch(error){}
		this.stack = stack;
		this.variables = {};
		this.updateVariables(stack['varLists']);
	}

	// handle new variable info
	private updateVariables(varLists: any[]){
		varLists.forEach(varList => {
			if(varList['isReady']){
				this.variables[varList['reference']] = (varList['variables'] as DebugProtocol.Variable[]);
			}
		});
		console.log('updated: variables');
	}

	// request info about the stack and workspace from R:
	private requestInfoFromR(args: anyRArgs = []) {
		const args2: anyRArgs = {
			id: ++this.requestId,
			isError: this.isCrashed,
			includePackages: this.includePackages
		};
		this.rSession.callFunction('.vsc.getStack', args, args2);
		return this.waitForMessages();
	}

	// request info about specific variables from R:
	private requestVariablesFromR(refs: number[]){
		const rArgs: anyRArgs = {'refs': refs, 'id': ++this.requestId};
		this.rSession.callFunction('.vsc.getVarLists', rArgs);
		return this.waitForMessages();
	}


	///////////////////////////////////////////////
	// FLOW CONTROL
	///////////////////////////////////////////////

	// continue script execution:
	public continue(reverse = false) {
		if(this.debugMode === 'global'){
			const filename = vscode.window.activeTextEditor.document.fileName;
			this.debugSource(filename);
		} else{
			this.expectBrowser = false;
			this.runCommandAndSendEvent('c', '');
		}
	}

	// debug source:
	public debugSource(filename: string){
		this.setAllBreakpoints();
		this.rSession.callFunction('.vsc.debugSource', {file: filename});
		const rCall = makeFunctionCall('.vsc.debugSource', {file: filename});
		this.startOutputGroup(rCall, true);
		this.endOutputGroup();
		this.requestInfoFromR({dummyFile: filename});
		// this.sendEventOnStack = 'stopOnStepPreserveFocus';
		this.sendEventOnStack = 'stopOnStep';
	}

	// step:
	public async step(reverse = false, event = 'stopOnStep') {
		this.runCommandAndSendEvent('n');
	}

	// step into function:
	public async stepIn(event = 'stopOnStep') {
		this.runCommandAndSendEvent('s');
	}

	// execute rest of function:
	public async stepOut(reverse = false, event = 'stopOnStep') {
		this.runCommandAndSendEvent('f');
	}

	private async runCommandAndSendEvent(command: string, event: string = 'stopOnStep'){
		if(this.isCrashed){
			if(this.allowDebugGlobal){
				this.returnToPrompt();
			} else{
				this.terminateFromPrompt();
			}
		} else {
			await this.waitForMessages();
			this.rSession.runCommand(command);
			await this.requestInfoFromR();
			this.sendEvent(event);
		}
	}
	
	// evaluate an expression entered into the debug window in R
	public evaluate(expr: string, frameId: number | undefined, context: string|undefined) {
		var silent: boolean = false;
		if(context==='watch'){
			silent = true;
		}
		if(isUndefined(frameId)){
			frameId = 0;
		}
		expr = escapeStringForR(expr, '"');
		const rId = ++this.requestId;
		const rArgs = {
			expr: expr,
			frameId: frameId,
			silent: silent,
			catchErrors: !this.breakOnErrorFromConsole,
			id: rId
		};
		this.rSession.callFunction('.vsc.evalInFrame', rArgs, [], false);
		if(!silent){
			this.requestInfoFromR();
		}
		return rId;
	}



	//////////////////////////
	// STACK INFO

	public getStack(startFrame: number, endFrame: number) {
		// can be returned synchronously since step-events are sent only after receiving stack info
		return this.stack;
	}

	public getScopes(frameId: number) {
		// can be returned synchronously since step-events are sent only after receiving stack info
		// stack info includes scopes
		return this.stack['frames'][frameId]['scopes'];
	}

	public async getVariables(varRef: number) {
		if(this.variables[varRef]){
			// variable info is already known
			return this.variables[varRef];
		} else{
			// variable info is produced lazily --> request from R
			this.requestVariablesFromR([varRef]);
			await this.waitForMessages();
			return this.variables[varRef];
		}
	}


	///////////////////////////////
	// COMPLETION

	public async getCompletions(frameId:number, text:string, column:number, line:number){
		this.rSession.callFunction('.vsc.getCompletion', {
			frameIdVsc: frameId,
			text: text,
			column: column,
			line: line,
			onlyGlobalEnv: (this.debugMode === 'global'),
			id: ++this.requestId
		});
		await this.waitForMessages();
	}


	////////////////////////////
	// BREAKPOINT CONTROL

	public setBreakPoint(path: string, line: number) : DebugBreakpoint {

		const bp = <DebugBreakpoint> {verified: false, line: line, id: this.breakpointId++};
		let bps = this.breakPoints.get(path);
		if (!bps) {
			bps = new Array<DebugBreakpoint>();
		}
		bps.push(bp);
		this.breakPoints.set(path, bps);

		const setBreakPointsInPackages = false;
		const lines: number[] = bps.map(bp => bp.line);
		const ids: number[] = bps.map(bp => bp.id);
		const rArgs = {
			file: path,
			lines: lines,
			includePackages: setBreakPointsInPackages,
			ids: ids
		};

		if(this.isRunningCustomCode){
			this.rSession.callFunction('.vsc.addBreakpoints', rArgs);
		}

		return bp;
	}

	private async setAllBreakpoints(){
		// set breakpoints in R
		// to be used after source()ing a R file and before calling the main() function from it
		this.breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
			const lines = bps.map(bp => bp.line);
			const ids = bps.map(bp => bp.id);
			const rArgs = {
				file: path,
				lines: lines,
				includePackages: this.setBreakpointsInPackages,
				ids: ids
			};
			this.rSession.callFunction('.vsc.addBreakpoints', rArgs);
		});
		if(this.debugMode==='function'){
			this.rSession.callFunction('.vsc.setStoredBreakpoints');
		}

	}

	public clearBreakPoint(path: string, line: number) : DebugBreakpoint | undefined {
		// dummy
		return undefined;
	}

	public clearBreakpoints(path: string): void {
		this.breakPoints.delete(path);
		if(this.isRunningCustomCode){
			this.rSession.callFunction('.vsc.clearBreakpointsByFile', {file: path});
		}
	}

	public setDataBreakpoint(address: string): boolean {
		// dummy
		return false;
	}

	public clearAllDataBreakpoints(): void {
		// dummy
	}

	public getBreakpoints(path: string, line: number): number[] {
		// dummy
		const bps: number[] = [];
		return bps;
	}



	///////////////////////////////
	// functions to terminate the debug session

	public killR(): void {
		this.rSession.ignoreOutput = true;
		this.isRunningCustomCode = false;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		// this.sendEvent('end');
	}

	public terminateFromPrompt(): void {
		this.rSession.ignoreOutput = true;
		this.isRunningCustomCode = false;
		this.rSession.clearQueue();
		if(this.debugMode === 'function'){
			this.rSession.runCommand('Q', [], true);
			this.rSession.callFunction('quit', {save: 'no'}, [], true, 'base',true);
			const infoString = "You terminated R while debugging a function.\n" +
				"If you want to keep the R session running and only exit the function, use 'Restart' (Ctrl+Shift+F5).\n";
			this.sendEvent('output', infoString, "console");
			this.sendEvent('end');
		} else{
			this.rSession.callFunction('quit', {save: 'no'}, [], true, 'base',true);
			this.sendEvent('end');
		}
	}

	public async returnToPrompt() {
		this.rSession.clearQueue();
		if(this.debugMode === 'function'){
			this.rSession.runCommand('Q', [], true);
		}
		this.debugMode = 'global';
		this.currentLine = 0;
		const filename = vscode.window.activeTextEditor.document.fileName;
		await this.requestInfoFromR({dummyFile: filename, forceDummyStack: true});
		// this.sendEventOnStack = 'stopOnStepPreserveFocus';
		this.sendEvent('stopOnStep');
		// this.sendEventOnStack = 'stopOnStep';
	}

	public terminate(): void {
		this.rSession.ignoreOutput = true;
		this.isRunningCustomCode = false;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		this.sendEvent('end');
	}

	public resetRInput(): void {
		this.sendEventOnStack = 'stopOnException';
		this.rSession.clearQueue();
		this.requestInfoFromR();
	}

	public cancel(): void {
		this.rSession.clearQueue();
	}
}
