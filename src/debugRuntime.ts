/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync, write } from 'fs';
import { EventEmitter } from 'events';
import { Terminal, window } from 'vscode';
import * as vscode from 'vscode';
import {ToRStringLiteral, getRPath, getTerminalPath } from "./rUtils";
import { TextDecoder, isUndefined } from 'util';

import * as debugadapter from 'vscode-debugadapter';

import { spawnChildProcess, createPseudoTerminal } from './pseudoTerminal';
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

	// the contents (= lines) of the one and only file
	private _sourceLines!: string[];

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
	private pt!: vscode.Terminal;
	private writeEmitter!: vscode.EventEmitter<string>;

	private hasStartedMain: boolean = false;
	private isRunningMain: boolean = false;
	private isPaused: boolean = false;

	private showUser: boolean = false;

	// used to store text if only part of a line is read form cp.stdout/cp.sterr
	private restOfStdout: string = "";
	private restOfStderr: string = "";

	private stdoutIsBrowserInfo = false; // set to true if cp.stdout is currently giving browser()-details

	private variables: any = undefined;
	private scopes: any = undefined;
	private stack: any = undefined;
	private requestId = 0;
	private messageId = 0;

	// delimiters used when printing info from R which is meant for the debugger
	// currently need to occurr on the same line!
	// are passed to RegExp() -> need to be escaped 'double'
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
		
		console.log('go!');

		// //Create output channel
		// let orange = vscode.window.createOutputChannel("Orange");
		// //Write to output.
		// orange.appendLine("I am a banana.");

		this._sourceFile = program;

		this.sendEvent('output', 'startCollapsed: Starting R session...');

		this.sendEvent('output',`delimiter0: ${this.delimiter0}\ndelimiter1:${this.delimiter1}\nR-Prompt: ${this.rprompt}`)

		// is set to true, once main() is called in R
		this.isRunningMain = false;
		
		this.cp = spawnChildProcess(path.dirname(program));

		// handles input to the R process
		const inputHandler = (data: any) => {
			this.cp.stdin.write(data);
			console.log('stdin: ' + data)
		}

		// writes output to the pseudoterminal
		this.writeEmitter = new vscode.EventEmitter<string>();

		// pseudoterminal shown to the user
		this.pt = createPseudoTerminal(inputHandler, this.writeEmitter);
		this.pt.show(false);

		// start R
		// const Rpath = '"C:\\Program Files\\R\\R-3.6.3\\bin\\R.exe"';
		const Rpath = getRPath();
		const cmdStartR = Rpath + " --ess --quiet --interactive --no-save\n";
		this.runCommand(cmdStartR, true, true);

		// load helper functions etc.
		// const fileNamePrep = "prep.R"
		const fileNamePrep = vscode.workspace.getConfiguration().get<string>('rdebugger.prep.r','prep.R');
		const cmdSourcePrep = 'source(' + ToRStringLiteral(fileNamePrep, '"') + ')';
		this.runCommand(cmdSourcePrep, true, true)

		// source file that is being debugged
		const cmdSourceProgram = 'source(' + ToRStringLiteral(program, '"') + ')';
		this.runCommand(cmdSourceProgram, true, true)

		// set breakpoints in R
		this._breakPoints.forEach((bps: DebugBreakpoint[], path:string) => {
			bps.forEach((bp: DebugBreakpoint) => {
				var command = '.vsc.mySetBreakpoint(' + ToRStringLiteral(path, '"') + ', ' + bp.line + ')\n';
				this.runCommand(command, true, true)
			})
		})
		
		// handle output from the R-process
		this.cp.stdout.on("data", data => {
			this.handleData(data);
		});
		this.cp.stderr.on("data", data => {
			this.handleData(data, true);
		})

		// call main()
		// TODO: replace runMain() with direct main() call
		const cmdRunMain = '.vsc.runMain()';
		// command = 'browser()'
		this.runCommand(cmdRunMain, true, true)
		this.sendEvent('output', 'end: ')
	}

	private runCommand(command: string, addNewline = true, logToDebugConsole = false){
		// runs a give command in the R child process
		// adds newline if necessary
		if(logToDebugConsole){
			this.sendEvent('output', command)
		}
		if(command.slice(-1) != '\n' && addNewline){
			command = command + '\n'
		}
		this.cp.stdin.write(command);
		console.log('stdin:\n' + command.trim());
	}

	private writeOutput(text: any, addNewline = true, toStderr = false){
		if(text.slice(-1) != '\n' && addNewline){
			text = text + '\n'
		}
		if(toStderr){
			this.writeEmitter.fire("\x1b[31m");
			this.writeEmitter.fire(text);
			// this.writeEmitter.fire('\r\n');
			this.writeEmitter.fire("\x1b[0m");
		} else { // stdout
			this.writeEmitter.fire(text);
			// this.writeEmitter.fire('\r\n');
		}
		const category = (toStderr ? "stderr" : "stdout")
		this.sendEvent("output", text, category)
	}

	private handleData(data: any, fromStderr: boolean = false) {
		// handles output from the R child process
		// splits cp.stdout into lines / waits for complete lines
		// calls handleLine() on each line
		const dec = new TextDecoder
		var s = dec.decode(data);
		s = s.replace(/\r/g,'');
		if(fromStderr){
			s = this.restOfStderr + s;
			this.restOfStderr = "";
		} else {
			s = this.restOfStdout + s;
			this.restOfStdout = "";
		}
		const lines = s.split(/\n/)

		for(var i = 0; i<lines.length - 1; i++){
			var line = lines[i]
			this.handleLine(line, fromStderr);
		}

		if(lines.length > 0) {
			var remainingText = lines[lines.length - 1]
			const isHandled = this.handleLine(remainingText, fromStderr, false);
			// const isHandled = false;
			if(isHandled){
				remainingText = "";
			}
			if(fromStderr){
				this.restOfStderr = remainingText;
			} else {
				this.restOfStdout = remainingText;
			}
		}
	}
	

	private handleLine(line: string, fromStderr = false, isFullLine = true): boolean{
		// handles output-lines from R child process
		// if(this.isRunningMain) {
			var matches: any;
			var showLine = isFullLine && !this.stdoutIsBrowserInfo && this.isRunningMain;

			const debugRegex = new RegExp(this.delimiter0 + '(.*)' + this.delimiter1)
			
			matches = debugRegex.exec(line);
			if(matches){
				console.log('matches: <vsc>')
				this.handleJson(matches[1]);
				line = line.replace(debugRegex, '');
			}

			if(/Browse\[\d+\]>/.test(line)){
				if(!this.isPaused){
					this.isPaused = true;
				}
				showLine = false;
				this.stdoutIsBrowserInfo = false;
				return true;
			} 
			if(/Called from: /.test(line)){
				showLine = false;
			}
			if(isFullLine && /^[ncsfQ]$/.test(line)) {
				console.log('matches: [ncsfQ]')
				showLine = false;
			}
			if(isFullLine && /^\.vsc\./.test(line)) {
				console.log('matches: .vsc')
				showLine = false;
			}
			if(isFullLine && (/debug: /.test(line) ||
					/exiting from: /.test(line) ||
					/debugging in: /.test(line))){
				showLine = false;
				this.stdoutIsBrowserInfo = true;
			}
			matches = /^debug at (.*)#(\d+): .*$/.exec(line)
			if(matches){
				this._currentFile = matches[1];
				this._currentLine = parseInt(matches[2]);
				showLine = false;
				this.stdoutIsBrowserInfo = true;
			}
			// if(this.isRunningMain && /<#>$/.test(line)){
			// 	console.log("matches: <#> (End)");
			// 	this.sendEvent('end')
			// 	return true;
			// } //else {
			if(showLine){
				if(isFullLine && line.length>0){
					line = line + '\n'
				}
				this.writeOutput(line, fromStderr)
			}
		return false
	}

	private handleJson(json: string){
		const j = JSON.parse(json);
		const message = j['message'];
		const body = j['body'];
		const id = j['id'];
		console.log('message ' + id + ': ' + message)
		if(id > this.messageId){
			this.messageId = id;
		}
		switch(message){
			case 'breakpoint':
				this.requestInfoFromR();
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
				this.stack = body;
				break;
			default:
				console.warn('Unknown message: ' + message)
		}
	}
	
	private async waitForMessages(){
		const poll = (resolve: () => void) => {
			if(this.messageId >= this.requestId){
				resolve();
			} else {
				setTimeout(_ => poll(resolve), 100);
			}
		}
		return new Promise(poll);
	}

	private requestInfoFromR(): number {
		this.runCommand('.vsc.describeLs2(id=' + ++this.requestId + ')');
		this.runCommand('.vsc.getStack(id=' + ++this.requestId + ')');
		return(this.requestId)
	}

	///////////////////////////////////////////////
	// step-control
	///////////////////////////////////////////////

	public continue(reverse = false) {
		this.isPaused = false;
		this.runCommand('c');
	}

	public step(reverse = false, event = 'stopOnStep') {
		this.runCommand('n');
		this.requestInfoFromR()
		this.sendEvent(event);
	}

	public stepIn(event = 'stopOnStep') {
		this.runCommand('s');
		this.requestInfoFromR()
		this.sendEvent(event);
	}

	public stepOut(reverse = false, event = 'stopOnStep') {
		this.runCommand('f');
		this.requestInfoFromR()
		this.sendEvent(event);
	}


	// info for debug session
	public async getScopes(frameId: number) {
		const envString = this.stack['frames'][frameId]
		if(isUndefined(this.scopes) || this.scopes[0][0] != envString){
			this.runCommand('.vsc.describeLs2(id=' + ++this.requestId + ', envString=' + ToRStringLiteral(envString, '"') + ')');
			await this.waitForMessages();
		}
		// wrapper to access scopes
		return this.scopes;
	}

	public async getVariables(scope: string) {
		for(var i=0; i<this.scopes[0].length; i++){
			if(this.scopes[0][i] == scope){
				return this.scopes[1][i];
			}
		}
		return [];
	}

	public async getStack(startFrame: number, endFrame: number) {
		const frames = new Array<any>();

		if(isUndefined(this.stack)){
			this.requestInfoFromR();
			await this.waitForMessages();
		}

		for(var i=0; i<this.stack['calls'].length; i++){
			var line: number;
			if(i<this.stack['calls'].length-1){
				line = this.stack['lineNumbers'][i+1];
			} else {
				line = this._currentLine;
			}
			frames.unshift({
				index: i,
				name: this.stack['calls'][i],
				// file: this._sourceFile, // TODO: get correct file!
				// file: this._currentFile,
				file: this.stack['fileNames'][i],
				line: line
				// line: this.stack['lineNumbers'][i]
				// line: this._currentLine //TODO: get correct line!
			})
		}

		return {
			frames: frames,
			count: frames.length
		};
	}

	public getBreakpoints(path: string, line: number): number[] {

	// 	const l = this._sourceLines[line];

	// 	let sawSpace = true;
		const bps: number[] = [];
	// 	for (let i = 0; i < l.length; i++) {
	// 		if (l[i] !== ' ') {
	// 			if (sawSpace) {
	// 				bps.push(i);
	// 				sawSpace = false;
	// 			}
	// 		} else {
	// 			sawSpace = true;
	// 		}
	// 	}

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
		this.cp.kill()
		this.pt.dispose()
	}





	// private methods

	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {
		// if (reverse) {
		// 	for (let ln = this._currentLine-1; ln >= 0; ln--) {
		// 		if (this.fireEventsForLine(ln, stepEvent)) {
		// 			this._currentLine = ln;
		// 			return;
		// 		}
		// 	}
		// 	// no more lines: stop at first line
		// 	this._currentLine = 0;
		// 	this.sendEvent('stopOnEntry');
		// } else {
		// 	for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
		// 		if (this.fireEventsForLine(ln, stepEvent)) {
		// 			this._currentLine = ln;
		// 			return true;
		// 		}
		// 	}
		// 	// no more lines: run to end
		// 	this.sendEvent('end');
		// }
	}

	private verifyBreakpoints(path: string) : void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			// this.loadSource(path);
			bps.forEach(bp => {
				// if (!bp.verified && bp.line < this._sourceLines.length) {
				// 	const srcLine = this._sourceLines[bp.line].trim();

				// 	// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
				// 	if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
				// 		bp.line++;
				// 	}
				// 	// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
				// 	if (srcLine.indexOf('-') === 0) {
				// 		bp.line--;
				// 	}
				// 	// don't set 'verified' to true if the line contains the word 'lazy'
				// 	// in this case the breakpoint will be verified 'lazy' after hitting it once.
				// 	if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
				// 	}
				// }
			});
		}
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	// private fireEventsForLine(ln: number, stepEvent?: string): boolean {

	// 	const line = this._sourceLines[ln].trim();

	// 	// if 'log(...)' found in source -> send argument to debug console
	// 	const matches = /log\((.*)\)/.exec(line);
	// 	if (matches && matches.length === 2) {
	// 		this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
	// 	}

	// 	// if a word in a line matches a data breakpoint, fire a 'dataBreakpoint' event
	// 	const words = line.split(" ");
	// 	for (let word of words) {
	// 		if (this._breakAddresses.has(word)) {
	// 			this.sendEvent('stopOnDataBreakpoint');
	// 			return true;
	// 		}
	// 	}

	// 	// if word 'exception' found in source -> throw exception
	// 	if (line.indexOf('exception') >= 0) {
	// 		this.sendEvent('stopOnException');
	// 		return true;
	// 	}

	// 	// is there a breakpoint?
	// 	const breakpoints = this._breakPoints.get(this._sourceFile);
	// 	if (breakpoints) {
	// 		const bps = breakpoints.filter(bp => bp.line === ln);
	// 		if (bps.length > 0) {

	// 			// send 'stopped' event
	// 			this.sendEvent('stopOnBreakpoint');

	// 			// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
	// 			// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
	// 			if (!bps[0].verified) {
	// 				bps[0].verified = true;
	// 				this.sendEvent('breakpointValidated', bps[0]);
	// 			}
	// 			return true;
	// 		}
	// 	}

	// 	// non-empty line
	// 	if (stepEvent && line.length > 0) {
	// 		this.sendEvent(stepEvent);
	// 		return true;
	// 	}

	// 	// nothing interesting found -> continue
	// 	return false;
	// }

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}