/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { config, escapeForRegex, getRStartupArguments } from "./utils";
import { isUndefined } from 'util';

import { RSession } from './rSession';
import { makeFunctionCall, anyRArgs } from './rUtils';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializeRequestArguments, InitializeRequest, RStartupArguments, DataSource, OutputMode } from './debugProtocolModifications';


const { Subject } = require('await-notify');
// import { Subject } from 'await-notify';

function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}




export class DebugRuntime extends EventEmitter {

	// delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// need to match those used in the R-package
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

	private rSessionStartup = new Subject();

	private rPackageStartup = new Subject();

	private initArgs: InitializeRequestArguments;

	// debugging
	private logLevel = 3;
	private logLevelCp = 3;

	// The rSession used to run the code
	public rSession: RSession;
	// Whether to use a queue for R commands (makes debugging slower but 'safer')
	private useRCommandQueue: boolean = true;
	// Time in ms to wait before sending an R command (makes debugging slower but 'safer')
	private waitBetweenRCommands: number = 0;

	public host = 'localhost';
	public port: number = 0;

	// state info about the R session
	private rSessionReady: boolean = false; // is set to true after executing the first R command successfully
	private rPackageFound: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private stdoutIsBrowserInfo = false; // set to true if rSession.stdout is currently giving browser()-details
	private isCrashed: boolean = false; // is set to true upon encountering an error (in R)
	private expectBrowser: boolean = false; // is set to true if a known breakpoint is encountered (indicated by "tracing...")
	private outputGroupLevel: number = 0; // counts the nesting level of output to the debug window

	// info about the R stack, variables etc.
	private startupTimeout = 1000; // time to wait for R and the R package to laod before throwing an error
	private terminateTimeout = 50; // time to wait before terminating to give time for messages to appear
	private debugPrintEverything = false;

	// debugMode
	public allowGlobalDebugging: boolean = false;
	private debugState: ('prep'|'function'|'global') = 'global';
	private outputModes: {[key in DataSource]?: OutputMode} = {};
	public sendContinueOnBrowser: boolean = false;




	// constructor
	constructor() {
		super();
	}

	public async initializeRequest(response: DebugProtocol.InitializeResponse, args: InitializeRequestArguments, request: InitializeRequest) {

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
		args.rStrings = this.rStrings;

		// read settings from vsc-settings
		this.useRCommandQueue = config().get<boolean>('useRCommandQueue', true);
		this.waitBetweenRCommands = config().get<number>('waitBetweenRCommands', 0);
		this.debugPrintEverything = config().get<boolean>('printEverything', this.debugPrintEverything);
		this.startupTimeout = config().get<number>('startupTimeout', this.startupTimeout);
		this.outputModes["stdout"] = config().get<OutputMode>('printStdout', 'nothing');
		this.outputModes["stderr"] =  config().get<OutputMode>('printStderr', 'all');
		this.outputModes["sinkSocket"] =  config().get<OutputMode>('printSinkSocket', 'filtered');


		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		this.startOutputGroup('Starting R session...', true);

		// start R in child process
		const rStartupArguments: RStartupArguments = await getRStartupArguments();
		rStartupArguments.useJsonServer = args.useJsonServer;
		rStartupArguments.useSinkServer = args.useSinkServer;
		rStartupArguments.logLevelCP = this.logLevelCp;
		this.writeOutput('R Startup:\n' + JSON.stringify(rStartupArguments, undefined, 2));
		// (essential R args: --interactive (linux) and --ess (windows) to force an interactive session)

		const thisDebugRuntime = this; // direct callback to this.handleLine() does not seem to work...
		this.rSession = new RSession();
		await this.rSession.startR(rStartupArguments, thisDebugRuntime);
		if (!this.rSession.successTerminal) {
			const message = 'Failed to spawn a child process!';
			await this.abortInitializeRequest(response, message);
			return false;
		}

		this.rSession.waitBetweenCommands = this.waitBetweenRCommands;

		args.useJsonServer = this.rSession.jsonPort > 0;
		if(args.useJsonServer){
			args.jsonHost = this.rSession.host;
			args.jsonPort = this.rSession.jsonPort;
		}

		args.useSinkServer = this.rSession.sinkPort > 0;
		if(args.useSinkServer){
			args.sinkHost = this.rSession.host;
			args.sinkPort = this.rSession.sinkPort;
		}

		this.initArgs = args;

		// CHECK IF R HAS STARTED

		// cat message from R
		this.rSession.callFunction('cat', this.rStrings.startup, '\n', true, 'base');

		// set timeout
		await this.rSessionStartup.wait(this.startupTimeout);
		if (this.rSessionReady) {
			console.log("R Session Ready");
		} else {
			const rPath = rStartupArguments.path;
			const message = 'R path not working:\n' + rPath;
			await this.abortInitializeRequest(response, message);
			this.writeOutput('R not responding within ' + this.startupTimeout + 'ms!', true, true);
			this.writeOutput('R path:\n' + rPath, true, true);
			return false;
		}


		// LOAD R PACKAGE

		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleLine()
		const tryCatchArgs: anyRArgs = {
			expr: makeFunctionCall('library', this.rStrings.packageName, [], false, 'base'),
			error: 'function(e)' + makeFunctionCall('cat', this.rStrings.libraryNotFound, '\n', true, 'base'),
			silent: true
		};
		this.rSession.callFunction('tryCatch', tryCatchArgs, [], false, 'base');

		// all R function calls from here on are (by default) meant for functions from the vsc-extension:
		this.rSession.defaultLibrary = this.rStrings.packageName;
		this.rSession.defaultAppend = this.rStrings.append;

		this.writeOutput('Initialize Arguments:\n' + JSON.stringify(args, undefined, 2));
		console.log(args);

		request.arguments = args;
		this.dispatchRequest(request);

		await this.rPackageStartup.wait(this.startupTimeout);
		if (this.rPackageFound) {
			// nice
			// this.endOutputGroup(); // is called after launch request
			return true;
		} else {
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

	public handleLine(line: string, from: DataSource, isFullLine: boolean): string {
		// handle output from the R process line by line
		// is called by rSession.handleData()

		const line0 = line;

		const isStderr = (from === "stderr");
		const outputMode = this.outputModes[from] || "all";

		var isSink: boolean;
		var isStdout: boolean;
		if(this.initArgs.useSinkServer){
			isSink = from === "sinkSocket";
			isStdout = from === "stdout";

		} else{
			isSink = (from === "sinkSocket") || (from === "stdout");
			isStdout = isSink;
		}

		// only show the line to the user if it is complete & relevant
		var showLine = isFullLine && !this.stdoutIsBrowserInfo && isSink;

		// filter out info meant for vsc:
		const jsonRegex = new RegExp(escapeForRegex(this.rStrings.delimiter0) + '(.*)' + escapeForRegex(this.rStrings.delimiter1) + '$');
		const jsonMatch = jsonRegex.exec(line);
		if(jsonMatch && isFullLine){
			// is meant for the debugger, not the user
			this.rPackageFound = true;
			this.rPackageStartup.notify();
			this.handleJsonString(jsonMatch[1]);
			line = line.replace(jsonRegex, '');
		}

		// differentiate data source. Is non exclusive, in case sinkServer is not used
		if(isStdout){
			if(!this.rPackageFound && isFullLine){
				// This message is only sent once to verify that R has started
				// Check for R-Startup message
				if(RegExp(escapeForRegex(this.rStrings.startup)).test(line)){
					this.rSessionReady = true;
					this.rSessionStartup.notify();
					this.rSessionReady = true;
				}
				// This message is sent only if loading the R package throws an error
				// Check for Library-Not-Found-Message
				if(RegExp(escapeForRegex(this.rStrings.libraryNotFound)).test(line)){
					this.rPackageFound = false;
					this.rPackageStartup.notify();
				}
			} else {
				// Check for browser prompt
				const browserRegex = /Browse\[\d+\]> /;
				if(browserRegex.test(line)){
					console.log('matches: browser prompt');
					if(this.sendContinueOnBrowser){
						this.rSession.runCommand("c", [], true);
					} else{
						// R has entered the browser
						this.debugState = 'function';
						line = line.replace(browserRegex,'');
						showLine = false;
						this.stdoutIsBrowserInfo = false; // input prompt is last part of browser-info
						if(!this.expectBrowser){
							// unexpected breakpoint:
							this.hitBreakpoint(false);
						}
						this.rSession.showsPrompt();
					}
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
					if(this.isCrashed && !this.allowGlobalDebugging){
						this.terminate();
					} else{
						console.log("matches: prompt");
						this.debugState = 'global';
						this.rSession.showsPrompt();
						// this.endOutputGroup();
						this.expectBrowser = false;
						showLine = false;
					}
					line = '';
				}

				// check for continue prompt
				const continueRegex = new RegExp(escapeForRegex(this.rStrings.continue));
				if(continueRegex.test(line) && isFullLine){
					console.log("matches: continue prompt");
					this.writeOutput("...");
					showLine = false;
				}
			}
		}
		
		if(isSink){
			// contains 'normal' output
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
		}

		if(isStderr){
			showLine = true;
		}

		// determine if/what part of line is printed
		var lineOut: string;
		if(outputMode === "all"){
			lineOut = line0;
			line = "";
		} else if(showLine && outputMode === "filtered"){
			lineOut = line;
		} else{
			lineOut = "";
		}

		// output line
		if(lineOut.length>0){
			this.writeOutput(lineOut, isFullLine, isStderr);
		}

		// if line is shown it counts as handled
		if(showLine){
			line = '';
		}
		return line;
	}



	public handleJsonString(json: string, from?: DataSource, isFullLine: boolean = true){
		if(!isFullLine){
			return json;
		} else{
			const j = JSON.parse(json);
			this.handleJson(j);
			return "";
		}
	}

	public handleJson(json: any){
		if(!this.rPackageFound){
			this.rPackageFound = true;
			this.rPackageStartup.notify();
		}
		if(json.type==="response"){
			this.sendEvent("response", json);
		} else if(json.type==="event"){
			if(json.event === "stopped" && json.body.reason === 'exception'){
				this.stdoutIsBrowserInfo = true;
				this.isCrashed = true;
				this.expectBrowser = true;
				this.debugState = 'function';
				this.sendEvent("event", json);
			} else if(json.event === 'custom'){
				if(json.body.reason === "continueOnBrowserPrompt"){
					this.sendContinueOnBrowser = json.body.value;
				}
			} else{
				this.sendEvent("event", json);
			}
		} else{
			console.error("Unknown message:");
			console.log(json);
		}
	}


	// REQUESTS

	// receive requests from the debugSession
	public dispatchRequest(request: DebugProtocol.Request) {
		const json = JSON.stringify(request);
		this.rSession.callFunction('.vsc.handleJson', {json: json});
	}

	// // This version dispatches requests to the tcp connection instead of stdin
	// // Is not yet working properly. Current problems/todos:
	// //  - Some requests not handled by R (step, stepIn, stepOut, ...)
	// //  - .vsc.listenOnPort needs to be called everytime the prompt is shown
	// //    Is possible using addTaskCallback, but this does not work e.g. when stepping through code
	//
	// public dispatchRequest(request: DebugProtocol.Request, usePort: boolean = false) {
	// 	if(this.jsonServer.jsonSocket && usePort){
	// 		this.jsonServer.jsonSocket.write(json + '\n');
	// 	} else{
	// 		this.rSession.callFunction('.vsc.handleJson', {json: json});
	// 		this.rSession.callFunction('.vsc.listenOnPort', {timeout: 3});
	// 	}
	// }

	// send event to the debugSession
	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}



	//////////////////////////////////////////////
	// OUTPUT
	public writeOutput(text: string, addNewline = false, toStderr = false, filePath = '', line = 1, group?: ("start"|"startCollapsed"|"end"), data?: object){
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
			this.sendEvent("output", text, category, filePath, line, column, group, data);
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
	public endOutputGroup(){
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
			this.returnToPrompt();
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
			this.rSession.clearQueue();
			this.rSession.killChildProcess();
			// this.sendEvent('end');
		}
	}

	public terminateFromPrompt(): void {
		this.rSession.ignoreOutput = true;
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
		this.rSession.clearQueue();
		this.rSession.killChildProcess();
		this.sendEvent('end');
	}

	public cancel(): void {
		this.rSession.clearQueue();
	}
}
