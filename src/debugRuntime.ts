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

import { RSession, makeFunctionCall, anyRArgs } from './rSession';
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
	readonly rDelimiter0 = '<v\\s\\c>';
	readonly rDelimiter1 = '</v\\s\\c>';
	readonly rPrompt = '<#v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rContinue = '<##v\\s\\c>'; //actual prompt is followed by a newline to make easier to identify
	readonly rStartup = '<v\\s\\c\\R\\STARTUP>';
	readonly rLibraryNotFound = '<v\\s\\c\\LIBRARY\\NOT\\FOUND>';
	readonly packageName = 'vscDebugger';

	// The file we are debugging
	private sourceFile: string;

	// The current line
	private currentLine = 0;
	private currentFile = '';

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
	private isAlmostRunningMain: boolean = false;
	private isRunningMain: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details
	private isCrashed: boolean = false; // is set to true upon encountering an error (in R)
	private ignoreOutput: boolean = false; // is set to true after terminating the session
	private expectBrowser: boolean = false;
	private outputGroupLevel: number = 0;

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
	private callMain: boolean = false;
	private allowDebugGlobal: boolean = false;
	private debugMode: ('function'|'global') = 'function';
	private setBreakpointsInPackages: boolean = false;


	////////////////////////////////////////////////////
	// METHODS
	////////////////////////////////////////////////////

	// constructor
	constructor() {
		super();
	}

	// start
	public async start(program: string, allowDebugGlobal: boolean=true, callMain: boolean=false, mainFunction: string='main') {
		// set sourcefile
		this.sourceFile = program;
		// this.allowDebugGlobal = allowDebugGlobal; //currently not working!
		this.allowDebugGlobal = true;
		this.callMain = callMain;
		this.mainFunction = mainFunction;
		if(callMain){
			this.debugMode = 'function';
		} else{
			this.debugMode = 'global';
		}

		// read settings from vsc-settings
		const config = workspace.getConfiguration('rdebugger');
		this.useRCommandQueue = config.get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config.get<number>('waitBetweenRCommands', 0);

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
		const terminalPath = getTerminalPath(); // read OS-specific terminal path from config
		const rPath = getRPath(); // read OS-specific R path from config
		const cwd = path.dirname(program);
		// essential R args: --interactive (linux) and --ess (windows) to force an interactive session:
		const rArgs = ['--ess', '--quiet', '--interactive', '--no-save']; 

		this.writeOutput(''
			+ 'terminalPath: ' + terminalPath
			+ '\ncwd: ' + cwd
			+ '\nrPath: ' + rPath
			+ '\nrArgs: ' + rArgs.join(' ')
		);

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

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleData()
		this.writeOutput('library: ' + this.packageName);
		const libraryCommandArgs = {
			expr: makeFunctionCall('library', this.packageName, [], 'base'),
			error: 'function(e)' + makeFunctionCall('cat', toRStringLiteral(this.rLibraryNotFound), toRStringLiteral('\n'), 'base'),
			silent: true
		};
		this.rSession.callFunction('tryCatch', libraryCommandArgs, [], 'base');

		if(this.debugMode === 'function'){
			// source file that is being debugged
			this.writeOutput('program: ' + program);
			this.rSession.callFunction('source', toRStringLiteral(program), [], 'base');
		}

		// all R function calls from here on are meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.packageName;

		// prep r session
		const options = {
			overwritePrint: config.get<boolean>('overwritePrint', false),
			overwriteCat: config.get<boolean>('overwriteCat', false),
			findMain: (this.debugMode === 'function'),
			mainFunction: toRStringLiteral(this.mainFunction),
			debugGlobal: this.allowDebugGlobal
		};
		this.rSession.callFunction('.vsc.prepGlobalEnv', options);

		this.setBreakpointsInPackages = config.get<boolean>('setBreakpointsInPackages', false);

		this.endOutputGroup();
	}

	private setAllBreakpoints(){
		// set breakpoints in R
		this.breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
			const lines = bps.map(bp => bp.line);
			const ids = bps.map(bp => bp.id);
			const rArgs = {
				file: toRStringLiteral(path),
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
			if(this.ignoreOutput){ return; }
			await this.handleLine(lines[i], fromStderr);
		}

		if(lines.length > 0) {
			// abort output handling if ignoreOutput has been set to true
			if(this.ignoreOutput){ return; }

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
		const debugRegex = new RegExp(escapeForRegex(this.rDelimiter0) + '(.*)' + escapeForRegex(this.rDelimiter1));

		// filter out info meant for vsc:
		tmpMatches = debugRegex.exec(line);
		if(tmpMatches){
			// is meant for the debugger, not the user
			this.handleJson(tmpMatches[1]);
			line = line.replace(debugRegex, '');
		}

		// Check for R-Startup message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.rStartup)).test(line)){
			this.isReady = true;
		}

		// Check for Library-Not-Found-Message
		if(!this.isRunningMain && RegExp(escapeForRegex(this.rLibraryNotFound)).test(line)){
			console.error('R-Library not found!');
			vscode.window.showErrorMessage('Please install the R package "' + this.packageName + '"!');
			this.terminate();
		}

		// Breakpoints set with trace() are preceded by this:
		if(/Tracing (.*)step \d+/.test(line)){
			showLine = false;
			this.stdoutIsBrowserInfo = true;
			this.hitBreakpoint();
		}

		// Upon hitting a breakpoint/browser():
		tmpRegex = /Browse\[\d+\]> /;
		if(tmpRegex.test(line)){
			// R has entered the browser
			line = line.replace(tmpRegex,'');
			showLine = false;
			this.stdoutIsBrowserInfo = false; // input prompt is last part of browser-info
			if(!this.expectBrowser){
				// unexpected breakpoint:
				this.hitBreakpoint(false);
			}
			console.log('matches: browser prompt');
			this.rSession.showsPrompt();
		} 

		// filter out additional browser info:
		if(isFullLine && (/(?:debug|exiting from|debugging|Called from): /.test(line))){
			showLine = false; // part of browser-info
			this.stdoutIsBrowserInfo = true;
		}

		// get current line from browser:
		tmpMatches = /^debug at (.*)#(\d+): .*$/.exec(line);
		if(tmpMatches){
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
		tmpRegex = new RegExp(this.packageName + '::');
		//matches all calls to 'our' R package. (Refine in case the user makes such calls?)
		if(isFullLine && tmpRegex.test(line)) {
			// was a command sent to R by the debugger
			console.log('matches: vscDebugger::');
			showLine = false;
		}

		const continueRegex = new RegExp(escapeForRegex(this.rContinue));
		if(continueRegex.test(line) && isFullLine){
			console.log("matches: continue prompt");
			showLine = false;
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
			} else if(this.isAlmostRunningMain){
				this.isAlmostRunningMain = false;
				this.isRunningMain = true;
			} else if(this.isRunningMain){
				// this.sendEvent('end');
			}
			showLine = false;
			return '';
		}

		// output any part of the line that was not parsed
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
				const bp = body;
				this.sendEvent('breakpointValidated', bp);
				break;
			case 'lineAtBreakpoint':
				if(body.line>0){
					this.currentLine = body.line;
				}
				if(body.filename){
					this.currentFile = body.filename;
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
				this.isAlmostRunningMain = true;
				this.sendEventOnStack = 'stopOnEntry';
				this.rSession.useQueue = this.useRCommandQueue;
				this.requestInfoFromR();
				break;
			case 'callMain':
				this.rSession.useQueue = this.useRCommandQueue;
				this.setAllBreakpoints();
				this.rSession.callFunction(this.mainFunction,[],[],'');
				this.isAlmostRunningMain = true;
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
				await this.waitForMessages();
				this.sendEvent('evalResponse', result);
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

	private hitBreakpoint(expected: boolean = true){
		this.expectBrowser = true; //indicates that following browser statements are no 'new' breakpoint
		this.debugMode = 'function';
		if(expected){
			this.stdoutIsBrowserInfo = true; 
			this.rSession.clearQueue();
			this.rSession.callFunction('.vsc.getLineAtBreakpoint');
			this.rSession.runCommand('n');
		} else{
			this.rSession.clearQueue();
			this.rSession.callFunction('.vsc.getLineAtBrowser');
		}
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


	// handle new stack info
	private updateStack(stack: any[]){
		try {
			if(stack['frames'][0]['line'] === 0){
				stack['frames'][0]['line'] = this.currentLine;
			}
		} catch(error){}
		try {
			if(stack['frames'][0]['file'] === 0){
				stack['frames'][0]['file'] = this.currentFile;
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
		const args2 = {
			'id': ++this.requestId,
			'isError': this.isCrashed
		};
		this.rSession.callFunction('.vsc.getStack', args, args2);
		return this.waitForMessages();
	}

	// request info about specific variables from R:
	private requestVariablesFromR(refs: number[]){
		const args = {'refs': refs, 'id': ++this.requestId};
		this.rSession.callFunction('.vsc.getVarLists', args);
		return this.waitForMessages();
	}


	///////////////////////////////////////////////
	// FLOW CONTROL
	///////////////////////////////////////////////

	// continue script execution:
	public continue(reverse = false) {
		if(this.isCrashed){
			this.terminateFromPrompt();
		} else if(this.debugMode === 'function'){
			this.expectBrowser = false;
			this.rSession.runCommand('c');
		} else{
			this.setAllBreakpoints();
			const filename = vscode.window.activeTextEditor.document.fileName;
			const filenameR = toRStringLiteral(filename);
			this.rSession.callFunction('.vsc.debugSource', {file: filenameR});
			const rCall = makeFunctionCall('.vsc.debugSource', {file: filenameR});
			this.startOutputGroup(rCall, true);
			this.requestInfoFromR({dummyFile: filenameR});
			// this.sendEventOnStack = 'stopOnStepPreserveFocus';
			this.sendEventOnStack = 'stopOnStep';
		}
	}

	// step:
	public async step(reverse = false, event = 'stopOnStep') {
		if(this.isCrashed){
			this.terminateFromPrompt();
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
			this.terminateFromPrompt();
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
			this.terminateFromPrompt();
		} else {
			await this.waitForMessages();
			this.rSession.runCommand('f');
			this.requestInfoFromR();
			this.sendEvent(event);
		}
	}
	
	// evaluate an expression entered into the debug window in R
	public async evaluate(expr: string, frameId: number | undefined, context: string|undefined) {
		if(true){
			var silent: boolean = false;
			if(context==='watch'){
				silent = true;
			}
			if(isUndefined(frameId)){
				frameId = 0;
			}
			expr = toRStringLiteral(expr, '"');
			this.rSession.callFunction('.vsc.evalInFrame', {expr: expr, frameId: frameId, silent: silent});
			this.requestInfoFromR();
		} else{
			this.rSession.runCommand(expr);
			await this.requestInfoFromR();
			this.sendEvent('evalResponse', []);
		}
		
		// await this.waitForMessages();
	}


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
		// await this.waitForMessages();
		if(this.variables[varRef]){
			return this.variables[varRef];
		} else{
			this.requestVariablesFromR([varRef]);
			await this.waitForMessages();
			return this.variables[varRef];
		}
	}

	public getBreakpoints(path: string, line: number): number[] {
		// dummy
		const bps: number[] = [];
		return bps;
	}



	////////////////////////////
	// breakpoint control
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
			file: toRStringLiteral(path),
			lines: lines,
			includePackages: setBreakPointsInPackages,
			ids: ids
		};

		if(this.isRunningMain){
			this.rSession.callFunction('.vsc.addBreakpoints', rArgs);
		}

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

	public clearBreakPoint(path: string, line: number) : DebugBreakpoint | undefined {
		// dummy
		return undefined;
	}

	public clearBreakpoints(path: string): void {
		this.breakPoints.delete(path);
		if(this.isRunningMain){
			this.rSession.callFunction('.vsc.clearBreakpointsByFile', {file: toRStringLiteral(path)});
		}
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

	public terminateFromPrompt(): void {
		this.ignoreOutput = true;
		this.isRunningMain = false;
		this.rSession.clearQueue();
		if(this.debugMode === 'function'){
			this.rSession.runCommand('Q', [], true);
		} else{
			this.rSession.callFunction('quit', {save: '"no"'}, [], 'base');
		}
		this.sendEvent('end');
	}

	public terminate(): void {
		this.ignoreOutput = true;
		this.isRunningMain = false;
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
