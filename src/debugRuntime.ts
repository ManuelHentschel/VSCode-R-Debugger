
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { config, escapeForRegex, getRStartupArguments, timeout, escapeStringForR } from './utils';
import { checkPackageVersion } from './installRPackage';

import { RSession } from './rSession';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as MDebugProtocol from './debugProtocolModifications';
import { explainRPackage, PackageVersionInfo } from './installRPackage';
import { RExtension, HelpPanel } from './rExtensionApi';

import { Subject } from './subject';

import { logger } from './logging';

export type LineHandler = (line: string, from: DataSource, isFullLine: boolean) => string;
export type DapHandler = (dap: Buffer) => Buffer;

export type DataSource = 'stdout'|'stderr'|'dapSocket'|'sinkSocket'|'stdin';
export type OutputMode = 'all'|'filtered'|'nothing';

interface WriteOnPrompt {
	text: string;
	which: 'browser'|'topLevel'|'prompt';
	count: number;
	addNewLine?: boolean;
}


export class DebugRuntime extends EventEmitter {

	// DEPRECATED: delimiters used when printing info from R which is meant for the debugger
	// need to occurr on the same line!
	// need to match those used in the R-package
	private rStrings = {
		prompt: '<#v\\s\\c>', //actual prompt is followed by a newline to make easier to identify
		continue: '<##v\\s\\c>', //actual prompt is followed by a newline to make easier to identify
		startup: '<v\\s\\c\\R\\STARTUP>',
		libraryNotFound: '<v\\s\\c\\LIBRARY\\NOT\\FOUND>',
		packageName: 'vscDebugger',
	};

	// The rSession used to run the code
	public rSession?: RSession;

	private readonly helpPanel?: HelpPanel;
	private readonly launchConfig: MDebugProtocol.LaunchConfiguration;

	// // state info about the R session
	// R session
	private rSessionStartup = new Subject(); // used to wait for R session to start
	private rSessionReady: boolean = false; // is set to true after executing the first R command successfully
	// R package
	private rPackageStartup = new Subject(); // used to wait for package to load
	private rPackageFound: boolean = false; // is set to true after receiving a message 'go'/calling the main() function
	private rPackageInfo?: MDebugProtocol.PackageInfo = undefined;
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

	private writeOnPrompt: WriteOnPrompt[] = [];

	// constructor
	constructor(helpPanel: HelpPanel | undefined, launchConfig: MDebugProtocol.LaunchConfiguration) {
		super();
		this.helpPanel = helpPanel;
		this.launchConfig = launchConfig;
	}

	public async initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: MDebugProtocol.InitializeRequestArguments,
		request: MDebugProtocol.InitializeRequest
	): Promise<boolean> {
		// This function initializes a debug session with the following steps:
		// 1. Handle arguments
		// 2. Launch a child process running R
		// 3. Check that the child process started 
		// 4. Load the R package vscDebugger
		// 5. Check that the R package is present and has a correct version


		//// (1) Handle arguments
		// update rStrings
		this.rStrings = {
			...this.rStrings,
			...args.rStrings
		};
		args.rStrings = this.rStrings;

		// read settings from vsc-settings
		const cfg = config();
		this.startupTimeout = cfg.get<number>('timeouts.startup', this.startupTimeout);
		this.terminateTimeout = cfg.get<number>('timeouts.terminate', this.terminateTimeout);
		this.outputModes['stdout'] = cfg.get<OutputMode>('printStdout', 'nothing');
		this.outputModes['stderr'] =  cfg.get<OutputMode>('printStderr', 'all');
		this.outputModes['stdin'] =  cfg.get<OutputMode>('printStdin', 'nothing');
		this.outputModes['sinkSocket'] =  cfg.get<OutputMode>('printSinkSocket', 'filtered');

		// start R in child process
		const rStartupArguments  = await getRStartupArguments(this.launchConfig);
		rStartupArguments.cwd ||= vscode.workspace.workspaceFolders?.[0].uri.fsPath;

		if(!rStartupArguments.path){
			const message = 'No R path was found in the settings/path/registry.\n(Can be changed in setting r.rpath.XXX)';
			await this.abortInitializeRequest(response, message);
			return false;
		}

		// print some info about the rSession
		// everything following this is printed in (collapsed) group
		logger.info('R Startup:', rStartupArguments);

		//// (2) Launch child process
		const tmpHandleLine: LineHandler = (line: string, from: DataSource, isFullLine: boolean) => {
			return this.handleLine(line, from, isFullLine);
		};
		const tmpHandleDapData: DapHandler = (dap: Buffer) => {
			return this.handleDapData(dap);
		};
		const tmpEchoStdin = (text: string) => {
			if(this.outputModes['stdin'] === 'all'){
				setTimeout(() => this.writeOutput(text, false, 'stdout'), 0);
			}
		};
		this.rSession = new RSession(tmpHandleLine, tmpHandleDapData, tmpEchoStdin);
		// check that the child process launched properly
		const successTerminal = await this.rSession.startR(rStartupArguments);
		if (!successTerminal) {
			const message = 'Failed to spawn a child process!';
			await this.abortInitializeRequest(response, message);
			return false;
		}

		// read ports that were assigned to the child process and add to initialize args
		if(this.rSession.dapPort <= 0 || this.rSession.sinkPort <= 0){
			const message = 'Failed to listen on port!';
			await this.abortInitializeRequest(response, message);
			return false;
		} else{
			args.useDapSocket = true;
			args.dapHost = this.rSession.host;
			args.dapPort = this.rSession.dapPort;
			args.useSinkSocket = true;
			args.sinkHost = this.rSession.host;
			args.sinkPort = this.rSession.sinkPort;
		}

		//// (3) CHECK IF R HAS STARTED
		// cat message from R
		const escapedStartupString = escapeStringForR(this.rStrings.startup + '\n');
		const startupCmd = `base::cat(${escapedStartupString})`;
		this.rSession.writeToStdin(startupCmd);

		// `this.rSessionStartup` is notified when the output of the above `cat()` call is received
		await this.rSessionStartup.wait(this.startupTimeout);
		if (this.rSessionReady) {
			logger.info('R Session ready');
		} else {
			const rPath = rStartupArguments.path;
			const message = 'R path not working:\n' + rPath + '\n(Can be changed in setting r.rpath.XXX)';
			const abortPromise = this.abortInitializeRequest(response, message);
			this.writeOutput(`R not responding within ${this.startupTimeout}ms!`, true, 'stderr');
			this.writeOutput(`R path:\n${rPath}`, true, 'stderr');
			this.writeOutput('If R is installed but in a different path, please adjust the setting r.rpath.windows/mac/linux.\n');
			this.writeOutput(`If R might take more than ${this.startupTimeout}ms to launch, try increasing the setting r.debugger.timeouts.startup!\n`);
			await abortPromise;
			return false;
		}

		//// (4) Load R package
		// load R package, wrapped in a try-catch-function
		// missing R package will be handled by this.handleLine()
		const escapedLibraryNotFoundString = escapeStringForR(this.rStrings.libraryNotFound + '\n');
		const libraryCmd = `base::tryCatch(expr=base::library(${this.rStrings.packageName}), error=function(e) base::cat(${escapedLibraryNotFoundString}))`;
		this.rSession.writeToStdin(libraryCmd);

		logger.info('Initialize Arguments:', args);

		// actually dispatch the (modified) initialize request to the R package
		request.arguments = args;
		this.dispatchRequest(request);

		//// (5) Check that the package started and has ok version
		// `rPackageStartup` is notified when the response to the initialize request is received
		await this.rPackageStartup.wait(this.startupTimeout);

		if (this.rPackageFound && this.rPackageVersionCheck.versionOk) {
			logger.info('R Package ok');
		} else{
			let shortMessage: string = '';
			let longMessage: string = '';
			if(this.rPackageFound){ // but not version ok
				logger.info('R Package version not ok');
				shortMessage = this.rPackageVersionCheck.shortMessage;
				longMessage = this.rPackageVersionCheck.longMessage || '';
			} else{ // package completely missing
				logger.info('R Package missing');
				shortMessage = 'Please install the R package "' + this.rStrings.packageName + '"!';
				longMessage = 'The debugger requries the R package "' + this.rStrings.packageName + '"!';
			}
			const tmpWriteOutput = (text: string) => {
				this.writeOutput(text, true, 'console');
			};
			explainRPackage(tmpWriteOutput, longMessage);
			await this.abortInitializeRequest(response, shortMessage);
			return false;
		}
		// everything ok:
		return true;
	}

	protected async abortInitializeRequest(response: DebugProtocol.InitializeResponse, message: string): Promise<boolean>{
		// used to abort the debug session and return an unsuccessful InitializeResponse
		logger.error(message);
		// timeout to give messages time to appear before shutdown
		await timeout(this.terminateTimeout);
		// prep and send response
		response.success = false;
		response.message = message;
		this.sendProtocolMessage(response);
		this.killR();
		return false;
	}


	//////////
	// Output-handlers: (for output of the R process to stdout/stderr)
	//////////

	protected handleLine(line: string, from: DataSource, isFullLine: boolean): string {
		// handle output from the R process line by line
		// is called by rSession.handleData()

		const line0 = line;

		const isStderr = (from === 'stderr');
		const isSink = (from === 'sinkSocket');
		const isStdout = (from === 'stdout');

		const outputMode = this.outputModes[from] || 'all';

		// only show the line to the user if it is complete & relevant
		let showLine = isFullLine && !this.stdoutIsBrowserInfo && isSink;

		if(outputMode === 'all'){
			setTimeout(() => {
				this.writeOutput(line0, isFullLine, (isStderr ? 'stderr' : 'stdout'));
			}, 0);
		}

		// differentiate data source. Is non exclusive, in case sinkServer is not used
		if(isStdout){
			if(!this.rPackageFound && isFullLine){
				// This message is only sent once to verify that R has started
				// Check for R-Startup message
				if(RegExp(escapeForRegex(this.rStrings.startup)).test(line)){
					this.rSessionReady = true;
					this.rSessionStartup.notify();
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
					void this.handlePrompt('browser');
					// R has entered the browser
					line = line.replace(browserRegex,'');
					showLine = false;
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
					void this.handlePrompt('topLevel');
					showLine = false;
					line = '';
				}

				// check for continue prompt
				const continueRegex = new RegExp(escapeForRegex(this.rStrings.continue));
				if(continueRegex.test(line) && isFullLine){
					logger.debug('matches: continue prompt');
					this.writeOutput('...');
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
		let lineOut: string;
		if(outputMode === 'all'){
			// lineOut = line0;
			lineOut = '';
			line = '';
			// showLine = true;
			showLine = false;
		} else if(showLine && outputMode === 'filtered'){
			lineOut = line;
		} else{
			lineOut = '';
			showLine = false;
		}

		// output line
		if(lineOut.length>0 || showLine){
			this.writeOutput(lineOut, isFullLine, (isStderr ? 'stderr' : 'stdout'));
		}

		// if line is shown it counts as handled
		if(showLine){
			line = '';
		}
		return line;
	}

	protected async handlePrompt(which: 'browser'|'topLevel', text?: string): Promise<void> {
		logger.debug(`matches prompt: ${which}`);

		// wait for timeout to give dap socket time to catch up
		// might be useful to avoid async issues
		const timeout = config().get<number>('timeouts.prompt', 0);
		if(timeout>0){
			await new Promise(resolve => setTimeout(resolve, timeout));
		}
		logger.debug(`handling prompt: ${which}`);

		// input prompt is last part of browser-info
		// toggle after delay, to give sink-socket time to arrive
		this.stdoutIsBrowserInfo = false;
	
		const wop = this.writeOnPrompt.shift();
		if(wop){
			const matchesPrompt = (wop.which === 'prompt' || wop.which === which);
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
				logger.error('invalid writeOnPrompt entry');
			}
		} else {
			const cmdListen = `${this.rStrings.packageName}::.vsc.listenForDAP(timeout = -1)`;
			this.rSession?.writeToStdin(cmdListen);
			this.sendShowingPromptRequest(which, text);
		}
	}

	protected sendShowingPromptRequest(which: 'browser'|'topLevel', text?: string): void{
		const request: MDebugProtocol.ShowingPromptRequest = {
			command: 'custom',
			arguments: {
				reason: 'showingPrompt',
				which: which,
				text: text
			},
			seq: 0,
			type: 'request'
		};
		this.dispatchRequest(request);
	}
	
	protected handleDapData(dap: Buffer): Buffer {
		while(dap.length > 0){
			const m = /^Content-Length: (\d+)\r\n\r\n/.exec(dap.toString('utf-8'));
			if(!m){
				break;
			}
			const contentLength = Number(m[1]);
			const headerLength = m[0].length;
			if(dap.length < headerLength + contentLength){
				break;
			}
			const jsonString = dap.slice(headerLength, headerLength + contentLength).toString('utf-8');
			// const jsonString = dap.substr(headerLength, contentLength);
			const json = <{[key: string]: any}>JSON.parse(jsonString);
			this.handleJson(json);
			dap = dap.slice(headerLength + contentLength);
		}
		return dap;
	}

	protected handleJson(json: {[key: string]: any}): void {
		if(json.type === 'response'){
			if(json.command === 'initialize'){
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
					this.sendProtocolMessage(json as DebugProtocol.ProtocolMessage);
				}
			} else{
				this.sendProtocolMessage(json as DebugProtocol.ProtocolMessage);
			}
		} else if(json.type === 'event'){
			if(json.event === 'custom'){
				const body = json.body as {[key: string]: any};
				if(body.reason === 'writeToStdin'){
					this.handleWriteToStdinEvent(json.body);
				} else if(body.reason === 'viewHelp' && body.requestPath){
					this.helpPanel?.showHelpForPath(body.requestPath);
				}
			} else{
				this.sendProtocolMessage(json as DebugProtocol.ProtocolMessage);
			}
		} else{
			logger.error('Unknown message:');
			logger.error(json);
		}
	}

	// send DAP message to the debugSession
	protected sendProtocolMessage(message: DebugProtocol.ProtocolMessage): void {
		this.emit('protocolMessage', message);
	}

	protected handleWriteToStdinEvent(args: MDebugProtocol.WriteToStdinBody): void {
		let count: number = 0;
		if(args.count !== 0){
			count = args.count || 1;
		}
		const when = args.when || 'now';
		let text = args.text;
		if(args.addNewLine && args.text.slice(-1)!=='\n'){
			text = text + '\n';
		}
		if(when==='now'){
			for(let i=0; i<count; i++){
				this.writeToStdin(args.text);
			}
		} else{
			let which: 'prompt'|'browser'|'topLevel' = 'prompt';
			if(when === 'browserPrompt'){
				which = 'browser';
			} else if(when === 'topLevelPrompt'){
				which = 'topLevel';
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
	public writeToStdin(text: string): boolean {
		if(text){
			logger.debug('Writing to stdin: ', text);
			this.rSession?.writeToStdin(text);
			return true;
		} else{
			return false;
		}
	}


	// REQUESTS

	// This version dispatches requests to the tcp connection instead of stdin
	public dispatchRequest(request: DebugProtocol.Request, usePort: boolean = true): void {
		const json = JSON.stringify(request);
		const contentLength = Buffer.byteLength(json, 'utf8');
		const dapString = `Content-Length: ${contentLength}\r\n\r\n${json}`;
		if(!this.rSession){
			// ignore
		} else if(this.rSession.dapSocket){
			this.rSession.writeToDapSocket(dapString);
		} else {
			const escapedDap = escapeStringForR(dapString);
			const cmdDap = `${this.rStrings.packageName}:::.vsc.handleDap(${escapedDap})`;
			this.rSession?.writeToStdin(cmdDap);
		}
	}



	//////////////////////////////////////////////
	// OUTPUT
	public writeOutput(
		text: string,
		addNewline = false,
		category: ('console'|'stdout'|'stderr'|'telemetry') = 'stdout',
		line = 1,
	): boolean {
		// writes output to the debug console (of the vsc instance runnning the R code)
		// used during start up to print info about errors/progress
		if(text.slice(-1) !== '\n' && addNewline){
			text = text + '\n';
		}

		const event: DebugProtocol.OutputEvent = {
			event: 'output',
			seq: 0,
			type: 'event',
			body: {
				category: category,
				output: text,
				line: line,
				column: 1,
			}
		};
		this.sendProtocolMessage(event);
		return true; // output event was sent
	}


	public killR(signal='SIGKILL'): void {
		if(this.rSession){
			this.rSession.ignoreOutput = true;
			this.rSession.killChildProcess(signal);
		}
	}
}

