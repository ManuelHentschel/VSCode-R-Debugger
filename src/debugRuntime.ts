/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { config, getRPath, escapeForRegex } from "./utils";
import { isUndefined } from 'util';

import { RSession, makeFunctionCall, anyRArgs, escapeStringForR } from './rSession';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializeRequestArguments } from './debugSession';

const { Subject } = require('await-notify');

export interface DebugBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}




export class DebugRuntime extends EventEmitter {

	// delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// need to match those used in the R-package
	// TODO: replace with a dedicated pipe between R and vsc?
	private rStrings = {
		delimiter0: '<v\\s\\c>',
		delimiter1: '</v\\s\\c>',
		prompt: '<#v\\s\\c>', //actual prompt is followed by a newline to make easier to identify
		continue: '<##v\\s\\c>', //actual prompt is followed by a newline to make easier to identify
		startup: '<v\\s\\c\\R\\STARTUP>',
		libraryNotFound: '<v\\s\\c\\LIBRARY\\NOT\\FOUND>',
		packageName: 'vscDebugger',
		append: ' ### <v\\s\\c\\COMMAND>'
	};

	// delay in ms between polls when waiting for messages from R
	readonly pollingDelay = 10;

	// the directory in which to run the file
	private cwd: string;

	// maps from sourceFile to array of breakpoints
	private breakPoints = new Map<string, DebugBreakpoint[]>();
	public breakOnErrorFromFile: boolean = true;
	public breakOnErrorFromConsole: boolean = false;

	private rSessionStartup = new Subject();
	private rSessionReady: boolean = false;

	private rPackageStartup = new Subject();
	private rPackageFound: boolean = false;

	// debugging
	private logLevel = 3;

	// The rSession used to run the code
	private rSession: RSession;
	// Whether to use a queue for R commands (makes debugging slower but 'safer')
	private useRCommandQueue: boolean = true;
	// Time in ms to wait before sending an R command (makes debugging slower but 'safer')
	private waitBetweenRCommands: number = 0;

	// state info about the R session
	private hasStartedR: boolean = false; // is set to true after executing the first R command successfully
	private isRunningCustomCode: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details
	private isCrashed: boolean = false; // is set to true upon encountering an error (in R)
	private expectBrowser: boolean = false; // is set to true if a known breakpoint is encountered (indicated by "tracing...")
	private outputGroupLevel: number = 0; // counts the nesting level of output to the debug window

	// info about the R stack, variables etc.
	private messageId = 0; // id of the last function call response received from R (only updated if larger than the previous)
	private startupTimeout = 1000; // time to wait for R and the R package to laod before throwing an error
	private terminateTimeout = 50; // time to wait before terminating to give time for messages to appear
	private debugPrintEverything = false;

	// debugMode
	private allowGlobalDebugging: boolean = false;
	private debugState: ('prep'|'function'|'global') = 'global';





	// constructor
	constructor() {
		super();
	}

	public async initializeRequest(response: DebugProtocol.InitializeResponse, args: InitializeRequestArguments, request: DebugProtocol.InitializeRequest) {

		// LAUNCH R PROCESS
		if(args.rStrings){
			const rs1 = args.rStrings;
			const rs0 = this.rStrings;
			this.rStrings.delimiter0 = rs1.delimiter0 || rs0.delimiter0;
			this.rStrings.delimiter1 = rs1.delimiter1 || rs0.delimiter1;
			this.rStrings.prompt = rs1.prompt || rs0.prompt;
			this.rStrings.continue = rs1.continue || rs0.continue;
			this.rStrings.startup = rs1.startup || rs0.startup;
			this.rStrings.libraryNotFound = rs1.libraryNotFound || rs0.libraryNotFound;
			this.rStrings.packageName = rs1.packageName || rs0.packageName;
			this.rStrings.append = rs1.append || rs0.append;
		}

		// read settings from vsc-settings
		this.useRCommandQueue = config().get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config().get<number>('waitBetweenRCommands', 0);
		this.debugPrintEverything = config().get<boolean>('printEverything', this.debugPrintEverything);
		this.startupTimeout = config().get<number>('startupTimeout', this.startupTimeout);


		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		this.startOutputGroup('Starting R session...', true);
		this.writeOutput(''
			+ 'rDelimiter0: ' + this.rStrings.delimiter0
			+ '\nrDelimiter1: ' + this.rStrings.delimiter1
			+ '\nrPrompt: ' + this.rStrings.prompt
			+ '\nrContinue: ' + this.rStrings.continue
			+ '\nrStartup: ' + this.rStrings.startup
			+ '\nrLibraryNotFound: ' + this.rStrings.libraryNotFound
			+ '\nrAppend: ' + this.rStrings.append
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
			const message = 'Failed to spawn a child process!';
			await this.abortInitializeRequest(response, message);
			return false;
		}

		// CHECK IF R HAS STARTED

		// cat message from R
		this.rSession.callFunction('cat', this.rStrings.startup, '\n', true, 'base');

		// set timeout
		await this.rSessionStartup.wait(this.startupTimeout);
		if(this.rSessionReady){
			console.log("R Session Ready");
		} else{
			const message = 'R path not working:\n' + rPath;
			await this.abortInitializeRequest(response, message);
			this.writeOutput('R not responding within ' + this.startupTimeout + 'ms!', true, true)
			this.writeOutput('R path:\n' + rPath, true, true);
			return false;
		}
		

		// LOAD R PACKAGE

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleLine()
		this.writeOutput('library: ' + this.rStrings.packageName);
		const tryCatchArgs: anyRArgs = {
			expr: makeFunctionCall('library', this.rStrings.packageName, [], false, 'base'),
			error: 'function(e)' + makeFunctionCall('cat', this.rStrings.libraryNotFound, '\n', true, 'base'),
			silent: true
		};
		this.rSession.callFunction('tryCatch', tryCatchArgs, [], false, 'base');

		// all R function calls from here on are (by default) meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.rStrings.packageName;
		this.rSession.defaultAppend = this.rStrings.append;

		this.dispatchRequest(request);

		await this.rPackageStartup.wait(this.startupTimeout);
		if(this.rPackageFound){
			// nice
			this.endOutputGroup();
			return true;
		} else{
			const message = 'Please install the R package "' + this.rStrings.packageName + '"!';
			await this.abortInitializeRequest(response, message);
			return false;
		}

	}

	private async abortInitializeRequest(response: DebugProtocol.InitializeResponse, message: string){
		console.error(message);
		this.endOutputGroup();
		this.writeOutput(message, true, true);
		await timeout(this.terminateTimeout);

		response.success = false;
		response.message = message;
		this.sendEvent('response', response);
		this.killR();
		return false;
	}



	//////////
	// Output-handlers: (for output of the R process to stdout/stderr)
	//////////

	public async handleLine(line: string, fromStderr = false, isFullLine = true) {
		// handle output from the R process line by line
		// is called by rSession.handleData()

		// make copy of line for debugging
		const line0 = line;

		// only show the line to the user if it is complete & relevant
		var showLine = isFullLine && !this.stdoutIsBrowserInfo;

		// filter out info meant for vsc:
		const jsonRegex = new RegExp(escapeForRegex(this.rStrings.delimiter0) + '(.*)' + escapeForRegex(this.rStrings.delimiter1) + '$');
		const jsonMatch = jsonRegex.exec(line);
		if(jsonMatch && isFullLine){
			// is meant for the debugger, not the user
			this.rPackageFound = true;
			this.rPackageStartup.notify();
			this.handleJson(jsonMatch[1]);
			line = line.replace(jsonRegex, '');
		}



		// Check for R-Startup message
		if(!this.isRunningCustomCode && RegExp(escapeForRegex(this.rStrings.startup)).test(line)){
			this.rSessionReady = true;
			this.rSessionStartup.notify();
			this.hasStartedR = true;
		}
		// Check for Library-Not-Found-Message
		if(!this.isRunningCustomCode && RegExp(escapeForRegex(this.rStrings.libraryNotFound)).test(line)){
			this.rPackageFound = false;
			this.rPackageStartup.notify();
		}


		// Breakpoints set with trace() or vscDebugger::mySetBreakpoint() are preceded by this:
		const tracingInfoRegex = /Tracing (.*)step.*$/;
		if(isFullLine && tracingInfoRegex.test(line)){
			// showLine = false;
			line = line.replace(tracingInfoRegex, '');
			this.stdoutIsBrowserInfo = true;
			this.expectBrowser = true;
			this.hitBreakpoint(true);
		}

		// filter out additional browser info:
		const browserInfoRegex = /(?:debug:|exiting from|debugging|Called from|debug at):? .*$/;
		if(isFullLine && (browserInfoRegex.test(line))){
			// showLine = false; // part of browser-info
			line = line.replace(browserInfoRegex, '');
			this.stdoutIsBrowserInfo = true;
		}

		// Check for browser prompt
		const browserRegex = /Browse\[\d+\]> /;
		if(browserRegex.test(line)){
			// R has entered the browser
			this.debugState = 'function';
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
		const echoRegex = new RegExp(escapeForRegex(this.rStrings.append) + '$');
		if(isFullLine && echoRegex.test(line)){
			// line = line.replace(echoRegex, '');
			showLine = false;
			console.log('matches: echo');
		}


		// check for prompt
		const promptRegex = new RegExp(escapeForRegex(this.rStrings.prompt));
		if (promptRegex.test(line) && isFullLine) {
			console.log("matches: prompt");
			this.debugState = 'global';
			this.rSession.showsPrompt();
			this.endOutputGroup();
			this.expectBrowser = false;
			showLine = false;
			return '';
		}

		// check for continue prompt
		const continueRegex = new RegExp(escapeForRegex(this.rStrings.continue));
		if(continueRegex.test(line) && isFullLine){
			console.log("matches: continue prompt");
			showLine = false;
		}

		// check for StdErr (show everything):
		if(fromStderr){
			showLine = true;
		}

		// output any part of the line that was not parsed
		if(this.debugPrintEverything){
			this.writeOutput(line0, isFullLine, fromStderr);
		} else if(showLine && line.length>0){
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

		// update Id of latest message
		// requests are handled sequentially by R --> no need to check for previous message Ids
		// use max() since unrequested messages are sent with id=0
		this.messageId = Math.max(this.messageId, id);

		switch(message){
			case 'response':
				this.sendEvent('response', body);
				break;
			case 'event':
				this.sendEvent('event', body);
				break;
			// case 'breakpointVerification':
			// 	// sent to report back after trying to set a breakpoint
			// 	const bp = body;
			// 	this.sendEvent('breakpointValidated', bp);
			// 	break;
			case 'error':
				// sent if an error was encountered by R and 
				this.stdoutIsBrowserInfo = true;
				this.isCrashed = true;
				this.expectBrowser = true;
				this.debugState = 'function';
				// event is sent after receiving stack from R in order to answer stack-request synchronously:
				// (apparently required by vsc?)
				this.sendEvent('stopOnException', body);
				break;
			case 'end':
				// can be sent e.g. after completing main()
				this.terminate();
				break;
		}
	}




	// REQUESTS

	public dispatchRequest(request: DebugProtocol.Request) {
		// this.rSession.callFunction('.vsc.dispatchRequest', <anyRArgs><unknown>request);
		this.rSession.callFunction('.vsc.dispatchRequest', {request: request});
	}


	//////////////////////////////////////////////
	// OUTPUT

	// send event to the debugSession
	private sendEvent(event: string, ... args: any[]) {
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

	private async hitBreakpoint(expected: boolean = true){
		this.expectBrowser = true; //indicates that following browser statements are no 'new' breakpoint
		this.debugState = 'function'; //browser is only called from inside a function/evaluated expression
		if(expected){
			// is sent BEFORE parsing all the browserInfo
			this.stdoutIsBrowserInfo = true; 
			// sent if the breakpoint was set by the debugger -> skip the browser() statement
			this.rSession.clearQueue();
			this.rSession.runCommand('n');
		} else{
			// unexpected breakpoint --> browser() statement is part of the actual source code
			// this.rSession.clearQueue();
		}
		this.sendEvent('stopOnBreakpoint');
	}


	///////////////////////////////////////////////
	// FLOW CONTROL
	///////////////////////////////////////////////

	// continue script execution:
	public async continue(request: DebugProtocol.Request) {
		if(this.debugState === 'global'){
			await vscode.window.activeTextEditor.document.save();
			const filename = vscode.window.activeTextEditor.document.fileName;
			this.debugSource(filename);
		} else{
			this.expectBrowser = false;
			this.runCommandAndSendEvent('c', '');
		}
	}

	// debug source:
	public async debugSource(filename: string){
		this.rSession.callFunction('.vsc.debugSource', { file: filename });
		const rCall = makeFunctionCall('.vsc.debugSource', { file: filename });
		this.startOutputGroup(rCall, true);
		this.endOutputGroup();
		this.sendEvent('stopOnStep');
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
		if (this.isCrashed) {
			if (this.allowGlobalDebugging) {
				this.returnToPrompt();
			} else {
				this.terminateFromPrompt();
			}
		} else {
			this.rSession.runCommand(command);
			this.sendEvent(event);
		}
	}







	///////////////////////////////
	// functions to terminate the debug session

	public killR(): void {
		if(this.rSession){
			this.rSession.ignoreOutput = true;
			this.isRunningCustomCode = false;
			this.rSession.clearQueue();
			this.rSession.killChildProcess();
			// this.sendEvent('end');
		}
	}

	public terminateFromPrompt(): void {
		this.rSession.ignoreOutput = true;
		this.isRunningCustomCode = false;
		this.rSession.clearQueue();
		if(this.debugState === 'function'){
			this.rSession.runCommand('Q', [], true);
			this.rSession.callFunction('quit', {save: 'no'}, [], true, 'base',true);
			if(this.allowGlobalDebugging){
				const infoString = "You terminated R while debugging a function.\n" +
					"If you want to keep the R session running and only exit the function, use:\n" + 
					" - 'Restart' (Ctrl+Shift+F5) when stopped on a normal breakpoint\n" +
					" - 'Continue' (F5) when stopped on an exception";
				this.sendEvent('output', infoString, "console");
			}
			this.sendEvent('end');
		} else{
			this.rSession.callFunction('quit', {save: 'no'}, [], true, 'base',true);
			this.sendEvent('end');
		}
	}

	public async returnToPrompt() {
		this.rSession.clearQueue();
		if(this.debugState === 'function'){
			this.rSession.runCommand('Q', [], true);
		}
		this.debugState = 'global';
		const filename = vscode.window.activeTextEditor.document.fileName;
		this.sendEvent('stopOnStep'); // Alternative might be: 'stopOnStepPreserveFocus';
	}

	public terminate(ignoreOutput: boolean = true): void {
		this.rSession.ignoreOutput = ignoreOutput;
		this.isRunningCustomCode = false;
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		this.sendEvent('end');
	}

	public async resetRInput() {
		this.rSession.clearQueue();
		this.sendEvent('stopOnException');

	}

	public cancel(): void {
		this.rSession.clearQueue();
	}
}
