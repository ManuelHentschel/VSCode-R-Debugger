/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { config, escapeForRegex, getRStartupArguments, timeout } from "./utils";
import { checkPackageVersion } from './installRPackage';

import { RSession } from './rSession';
import { makeFunctionCall, anyRArgs } from './rUtils';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as MDebugProtocol from './debugProtocolModifications';
import { explainRPackage, PackageVersionInfo } from './installRPackage';

const { Subject } = require('await-notify');

import * as log from 'loglevel';
const logger = log.getLogger("DebugRuntime");


export type LineHandler = (line: string, from: DataSource, isFullLine: boolean) => string;
export type JsonHandler = (json: string, from: DataSource, isFullLine: boolean) => string;

export type DataSource = "stdout"|"stderr"|"jsonSocket"|"sinkSocket";
export type OutputMode = "all"|"filtered"|"nothing";

interface WriteOnPrompt {
	text: string;
	which: "browser"|"topLevel"|"prompt";
	count: number;
	addNewLine?: boolean;
};


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
	};

	private initArgs: MDebugProtocol.InitializeRequestArguments;

	// The rSession used to run the code
	public rSession: RSession;
	// Time in ms to wait before sending an R command (makes debugging slower but 'safer'?)
	private waitBetweenRCommands: number = 0;

	// // state info about the R session
	// R session
	private rSessionStartup = new Subject(); // used to wait for R session to start
	private rSessionReady: boolean = false; // is set to true after executing the first R command successfully
	// R package
	private rPackageStartup = new Subject(); // used to wait for package to load
	private rPackageFound: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private rPackageInfo: MDebugProtocol.PackageInfo = undefined;
	private rPackageVersionCheck: PackageVersionInfo = {versionOk: false, shortMessage: '', longMessage: ''};
	// output state (of R process)
	private stdoutIsBrowserInfo: boolean = false; // set to true if rSession.stdout is currently giving browser()-details
	// output state (of this extension)
	private outputGroupLevel: number = 0; // counts the nesting level of output to the debug window

	// timeouts
	private startupTimeout = 1000; // time to wait for R and the R package to laod before throwing an error
	private terminateTimeout = 50; // time to wait before terminating to give time for messages to appear

	// debugMode
	private outputModes: {[key in DataSource]?: OutputMode} = {};

	public writeOnBrowserPrompt: string = "";
	public writeOnTopLevelPrompt: string = "";


	public writeOnPrompt: WriteOnPrompt[] = [];
	public writeOnPromptText: string = "";
	public writeOnWhichPrompt: ('browser'|'topLevel'|'prompt');
	public writeOnPromptCount: number = 0;



	// constructor
	constructor() {
		super();
		logger.setLevel(config().get<log.LogLevelDesc>('logLevelRuntime', 'info'));
	}

	public async initializeRequest(response: DebugProtocol.InitializeResponse, args: MDebugProtocol.InitializeRequestArguments, request: MDebugProtocol.InitializeRequest) {
		// This function initializes a debug session with the following steps:
		// 1. Handle arguments
		// 2. Launch a child process 
		// 3. Check that the child process started 
		// 4. Load the R package vscDebugger
		// 5. Check that the R package is present and has a correct version


		//// (1) Handle arguments
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
		}
		args.rStrings = this.rStrings;

		// read settings from vsc-settings
		this.waitBetweenRCommands = config().get<number>('waitBetweenRCommands', 0);
		this.startupTimeout = config().get<number>('startupTimeout', this.startupTimeout);
		this.outputModes["stdout"] = config().get<OutputMode>('printStdout', 'nothing');
		this.outputModes["stderr"] =  config().get<OutputMode>('printStderr', 'all');
		this.outputModes["sinkSocket"] =  config().get<OutputMode>('printSinkSocket', 'filtered');

		// start R in child process
		const rStartupArguments: MDebugProtocol.RStartupArguments = await getRStartupArguments();
		rStartupArguments.useJsonServer = args.useJsonServer;
		rStartupArguments.useSinkServer = args.useSinkServer;
		const openFolders = vscode.workspace.workspaceFolders;
		if(openFolders){
			rStartupArguments.cwd = openFolders[0].uri.fsPath;
		}

		if(!rStartupArguments.path){
			const message = 'No R path was found in the settings/path/registry.\n(Can be changed in setting rdebugger.rterm.XXX)';
			// const message = 'R path not working:\n' + rPath + '\n';
			await this.abortInitializeRequest(response, message);
			return false;
		}

		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		this.startOutputGroup('Starting R session...', true);
		this.writeOutput('R Startup:\n' + JSON.stringify(rStartupArguments, undefined, 2));


		//// (2) Launch child process
		const tmpHandleLine: LineHandler = (line: string, from: DataSource, isFullLine: boolean) => {
			return this.handleLine(line, from, isFullLine);
		};
		const tmpHandleJsonString: JsonHandler = (json: string, from?: DataSource, isFullLine: boolean = true) => {
			return this.handleJsonString(json, from, isFullLine);
		};
		this.rSession = new RSession();
		this.rSession.waitBetweenCommands = this.waitBetweenRCommands;
		// check that the child process launched properly
		const successTerminal = await this.rSession.startR(rStartupArguments, tmpHandleLine, tmpHandleJsonString);
		if (!successTerminal) {
			const message = 'Failed to spawn a child process!';
			await this.abortInitializeRequest(response, message);
			return false;
		}
		// read ports that were assigned to the child process and add to initialize args
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

		//// (3) CHECK IF R HAS STARTED
		// cat message from R
		this.rSession.callFunction('cat', this.rStrings.startup, '\n', true, 'base');
		// `this.rSessionStartup` is notified when the output of the above `cat()` call is received
		await this.rSessionStartup.wait(this.startupTimeout);
		if (this.rSessionReady) {
			logger.info("R Session ready");
		} else {
			const rPath = rStartupArguments.path;
			const message = 'R path not working:\n' + rPath + '\n(Can be changed in setting rdebugger.rterm.XXX)';
			await this.abortInitializeRequest(response, message);
			this.writeOutput('R not responding within ' + this.startupTimeout + 'ms!', true, true);
			this.writeOutput('R path:\n' + rPath, true, true);
			this.writeOutput('If R is installed but in a different path, please adjust the setting rdebugger.rterm.windows/mac/linux.');
			return false;
		}

		//// (4) Load R package
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
		this.writeOutput('Initialize Arguments:\n' + JSON.stringify(args, undefined, 2));

		// actually dispatch the (modified) initialize request to the R package
		request.arguments = args;
		this.dispatchRequest(request);

		//// (5) Check that the package started and has ok version
		// `rPackageStartup` is notified when the response to the initialize request is received
		await this.rPackageStartup.wait(this.startupTimeout);

		if (this.rPackageFound && this.rPackageVersionCheck.versionOk) {
			logger.info('R Package ok');
		} else{
			var shortMessage: string = '';
			var longMessage: string = '';
			if(this.rPackageFound){ // but not version ok
				logger.info('R Package version not ok');
				shortMessage = this.rPackageVersionCheck.shortMessage;
				longMessage = this.rPackageVersionCheck.longMessage;
			} else{ // package completely missing
				logger.info('R Package missing');
				shortMessage = 'Please install the R package "' + this.rStrings.packageName + '"!';
				longMessage = 'The debugger requries the R package "' + this.rStrings.packageName + '"!';
			}
			this.endOutputGroup();
			const tmpWriteOutput = (text: string) => {
				this.writeOutput(text, true, 'console');
			};
			explainRPackage(tmpWriteOutput, longMessage);
			await this.abortInitializeRequest(response, shortMessage, false);
			return false;
		}
		// everything ok:
		return true;
	}

	private async abortInitializeRequest(response: DebugProtocol.InitializeResponse, message: string, endOutputGroup: boolean = true){
		// used to abort the debug session and return an unsuccessful InitializeResponse
		logger.error(message);
		if(endOutputGroup){
			this.endOutputGroup();
		}
		// timeout to give messages time to appear before shutdown
		await timeout(this.terminateTimeout);
		// prep and send response
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
					this.handlePrompt("browser");
					// R has entered the browser
					line = line.replace(browserRegex,'');
					showLine = false;
					this.stdoutIsBrowserInfo = false; // input prompt is last part of browser-info
				} 


				// identify echo of browser commands sent by vsc
				if(isFullLine && /^[ncsfQ]$/.test(line)) {
					// commands used to control the browser
					logger.debug('matches: [ncsfQ]');
					showLine = false;
				}

				// check for prompt
				const promptRegex = new RegExp(escapeForRegex(this.rStrings.prompt));
				if (promptRegex.test(line) && isFullLine) {
					this.handlePrompt("topLevel");
					showLine = false;
					line = '';
				}

				// check for continue prompt
				const continueRegex = new RegExp(escapeForRegex(this.rStrings.continue));
				if(continueRegex.test(line) && isFullLine){
					logger.debug("matches: continue prompt");
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
				// this.hitBreakpoint(true);
				showLine = false;
			}

			// filter out additional browser info:
			const browserInfoRegex = /(?:debug:|exiting from|debugging|Called from|debug at):? .*$/;
			if(isFullLine && (browserInfoRegex.test(line))){
				// showLine = false; // part of browser-info
				line = line.replace(browserInfoRegex, '');
				this.stdoutIsBrowserInfo = true;
				showLine = false;
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
			showLine = true;
		} else if(showLine && outputMode === "filtered"){
			lineOut = line;
		} else{
			lineOut = "";
		}

		// output line
		if(lineOut.length>0 || showLine){
			this.writeOutput(lineOut, isFullLine, isStderr);
		}

		// if line is shown it counts as handled
		if(showLine){
			line = '';
		}
		return line;
	}

	private handlePrompt(which: "browser"|"topLevel", text?: string){
		logger.debug("matches prompt: " + which);
	
		if(this.writeOnPrompt.length > 0){
			const wop = this.writeOnPrompt.shift();
			const matchesPrompt = (wop.which === "prompt" || wop.which === which);
			if(matchesPrompt && wop.count > 0){
				this.writeToStdin(wop.text);
				wop.count -= 1;
				if(wop.count > 0){
					this.writeOnPrompt.unshift(wop);
				}
			} else if(matchesPrompt && wop.count < 0){
				this.writeToStdin(wop.text);
				this.writeOnPrompt.unshift(wop);
			} else{
				console.log('invalid wop');
			}
		} else {
			this.rSession.callFunction('.vsc.listenOnPort', {timeout: -1});
			this.sendShowingPromptRequest(which, text);
		}
	}

	private sendShowingPromptRequest(which: "browser"|"topLevel", text?: string){
		const request: MDebugProtocol.ShowingPromptRequest = {
			command: "custom",
			arguments: {
				reason: "showingPrompt",
				which: which,
				text: text
			},
			seq: 0,
			type: "request"
		};
		this.dispatchRequest(request);
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
		if(json.type === "response"){
			if(json.command === "initialize"){
				this.rPackageFound = true;
				this.rPackageInfo = (
					(<MDebugProtocol.InitializeResponse>json).packageInfo ||
					//0.1.1 is last version that does not return packageInfo:
					{Version: '0.1.1', Package: this.rStrings.packageName} 
				);
				const versionCheck = checkPackageVersion(this.rPackageInfo.Version);
				this.rPackageVersionCheck = versionCheck;
				this.rPackageStartup.notify();
				if(versionCheck.versionOk){
					this.sendEvent("response", json);
				} else{
					logger.info("event: " + json.event, json.body);
				}
			} else{
				this.sendEvent("response", json);
			}
		} else if(json.type === "event"){
			if(json.event === 'custom'){
				if(json.body.reason === "writeToStdin"){
					this.handleWriteToStdinEvent(json.body);
				}
				logger.info("event: " + json.event, json.body);
			} else{
				this.sendEvent("event", json);
			}
		} else{
			logger.error("Unknown message:");
			logger.error(json);
		}
	}

	public handleWriteToStdinEvent(args: MDebugProtocol.WriteToStdinBody){
		let count: number = 0;
		if(args.count !== 0){
			count = args.count || 1;
		}
		const when = args.when || "now";
		let text = args.text;
		if(args.addNewLine && args.text.slice(-1)!=="\n"){
			text = text + "\n";
		}
		if(when==="now"){
			for(let i=0; i<count; i++){
				this.writeToStdin(args.text);
			}
		} else{
			let which: "prompt"|"browser"|"topLevel";
			if(when === "prompt"){
				which = "prompt";
			} else if(when === "browserPrompt"){
				which = "browser";
			} else if(when === "topLevelPrompt"){
				which = "topLevel";
			}
			const newWriteOnPrompt: WriteOnPrompt = {
				text: text,
				which: which,
				count: count
			};
			if(args.stack && count === 0){
				// ignore
			} else if(args.stack){
				this.writeOnPrompt.push(newWriteOnPrompt);
			} else if(count === 0){
				this.writeOnPrompt = [];
			} else{
				this.writeOnPrompt = [newWriteOnPrompt];
			}
		}
	}
	public writeToStdin(text: string){
		if(text){
			logger.debug("Writing to stdin: ", text);
			this.rSession.runCommand(text, [], true);
			return true;
		} else{
			return false;
		}
	}


	// REQUESTS

	// This version dispatches requests to the tcp connection instead of stdin
	public dispatchRequest(request: DebugProtocol.Request, usePort: boolean = true) {
		const json = JSON.stringify(request);
		logger.info('request ' + request.seq + ': ' + request.command, request);
		if(!this.rSession.jsonSocket){
			logger.debug('not using socket!');
			this.rSession.callFunction('.vsc.handleJson', {json: json});
		} else {
			logger.debug('using socket!');
			this.rSession.jsonSocket.write(json + '\n');
		}
	}

	// send event to the debugSession
	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}



	//////////////////////////////////////////////
	// OUTPUT
	public writeOutput(
		text: string,
		addNewline = false,
		toStderr: (boolean|'console'|'stdout'|'stderr'|'telemetry') = false,
		filePath = '',
		line = 1,
		group?: ("start"|"startCollapsed"|"end"),
		data?: object
	){
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
			let category: string;
			if(toStderr===true){
				category = 'stderr';
			} else if(toStderr===false){
				category = 'stdout';
			} else{
				category = toStderr;
			}
			// const category = (toStderr ? "stderr" : "stdout");
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


	///////////////////////////////////////////////
	// FLOW CONTROL
	///////////////////////////////////////////////

	// continue script execution:
	public async continue(request: MDebugProtocol.ContinueRequest) {
		const doc = vscode.window.activeTextEditor.document;
		await doc.save();
		const filename = doc.fileName;
		request.arguments.source = {path: filename};
		this.dispatchRequest(request);
	}

	///////////////////////////////
	// functions to terminate the debug session

	public killR(signal='SIGKILL'): void {
		if(this.rSession){
			this.rSession.ignoreOutput = true;
			this.rSession.killChildProcess();
			// this.sendEvent('end');
		}
	}
}
