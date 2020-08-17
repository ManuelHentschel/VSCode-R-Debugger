

import * as child from 'child_process';
import { TextDecoder } from 'util';
import { DebugRuntime } from'./debugRuntime';
import { RStartupArguments, DataSource } from './debugProtocolModifications';
import { makeFunctionCall, anyRArgs  } from './rUtils';
import * as net from 'net';
const { Subject } = require('await-notify');

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}


// this is only typed to avoid typos in the function names
export type RFunctionName = (
    ".vsc.dispatchRequest" |
    "cat" |
    "print" |
    ".vsc.handleJson" |
    "tryCatch" |
    ".vsc.debugSource" |
    "quit" |
    ".vsc.listenOnPort"
);


export class RSession {
    public cp: child.ChildProcessWithoutNullStreams;
    public isBusy: boolean = false;
    public useQueue: boolean = false;
    public cmdQueue: string[] = [];
    public logLevel: number = 0;
    public logLevelCP: number = 0;
    public waitBetweenCommands: number = 0;
    public defaultLibrary: string = '';
    public defaultAppend: string = '';
    public successTerminal: boolean = false;
    public ignoreOutput: boolean=false;
    public debugRuntime: DebugRuntime;
    private restOfStderr: string='';
    private restOfStdout: string='';
    private handleLine: (line: string, from: DataSource, isFullLine: boolean) => string;
    private handleJsonString: (j: string, from: DataSource, isFullLine: boolean) => string;
    public jsonSocket: net.Socket;
    public sinkSocket: net.Socket;
    public jsonServer: net.Server;
    public sinkServer: net.Server;
    public host: string = 'localhost';
    public jsonPort: number = -1;
    public sinkPort: number = -1;

    // private restOfLine: Record<DataSource, string>;
    private restOfLine: {[k in DataSource]?: string} = {};


    // constructor(rPath: string, rArgs: string[]=[],
    //     // handleLine: (line:string,fromStderr:boolean,isFullLine:boolean)=>(Promise<string>),
    //     debugRuntime: DebugRuntime,
    //     logLevel=undefined, logLevelCP=undefined)
    constructor(){};
    
    public async startR(args: RStartupArguments, debugRuntime: DebugRuntime)
    {
        // spawn new terminal process (necessary for interactive R session)

        this.logLevel = args.logLevel || this.logLevel;
        this.logLevelCP = args.logLevelCP || this.logLevelCP;

        this.cp = spawnRProcess(args);

        if(this.cp.pid === undefined){
            this.successTerminal = false;
            return;
        }

        // store line handler
        // is only used for debugRuntim.handleLine()
        this.debugRuntime = debugRuntime;
        // this.handleLine = debugRuntime.handleLine;
        this.handleLine = (line, from, isFullLine) => debugRuntime.handleLine(line, from, isFullLine);
        // this.handleJsonString = debugRuntime.handleJson;
        this.handleJsonString = (j, from, isFullLine) => debugRuntime.handleJsonString(j, from, isFullLine);

		// handle output from the R-process
		this.cp.stdout.on("data", data => {
			this.handleData(data, "stdout");
		});
		this.cp.stderr.on("data", data => {
			this.handleData(data, "stderr");
        });

        const useJsonServer: boolean = args.useJsonServer || false;
        const useSinkServer: boolean = args.useSinkServer || false;

        const jsonPort = args.jsonPort || 0;
        const sinkPort = args.sinkPort || 0;

        const jsonServerReady = new Subject();
        const sinkServerReady = new Subject();

        if(useJsonServer && jsonPort>=0){
            const server = net.createServer((socket) => {
                socket.on('data', (data) => {
                    this.handleData(data, 'jsonSocket');
                });
                this.jsonSocket = socket;
            });
            server.listen(jsonPort, this.host, () => {
                this.jsonPort = getPortNumber(server);
                jsonServerReady.notify();
            });
            this.jsonServer = server;
        }

        if(useSinkServer && sinkPort>=0){
            const server = net.createServer((socket) => {
                socket.on('data', (data) => {
                    this.handleData(data, 'sinkSocket');
                });
                this.sinkSocket = socket;
            });
            server.listen(jsonPort, this.host, () => {
                this.sinkPort = getPortNumber(server);
                sinkServerReady.notify();
            });
            this.sinkServer = server;
        }

        await jsonServerReady.wait(1000);
        await sinkServerReady.wait(1000);


        this.successTerminal = true;
    }

    public async runCommand(cmd: string, args: (string|number)[]=[], force=false, append: string = ''){
        // remove trailing newline
		while(cmd.length>0 && cmd.slice(-1) === '\n'){
            cmd = cmd.slice(0, -1);
        }


        if(append === undefined){
            append = this.defaultAppend;
        }

        // append arguments (if any given) and newline
        if(args.length > 0){
            cmd = cmd + ' ' + args.join(' ') + append + '\n';
        } else {
            cmd = cmd + append + '\n';
        }

        // execute command or add to command queue
        if(!force && this.useQueue && this.isBusy){
            this.cmdQueue.push(cmd);
            if(this.logLevel>=3){
                console.log('rSession: stored command "' + cmd.trim() + '" to position ' + this.cmdQueue.length);
            }
        } else{
            this.isBusy = true;
            if(this.logLevel>=3){
                console.log('cp.stdin:\n' + cmd.trim());
            }
            if(this.waitBetweenCommands>0){
                await timeout(this.waitBetweenCommands);
            }
            this.cp.stdin.write(cmd);
        }
    }

    public clearQueue(){
        this.cmdQueue = [];
    }

    // Call this function to indicate that the previous command is done and the R-Process is idle:
    public showsPrompt(){
        if(this.cmdQueue.length>0){
            this.isBusy = true;
            const cmd = this.cmdQueue.shift();
            // console.log('rSession: calling from list: "' + cmd.trim() + '"');
            this.runCommand(cmd, [], true, '');
        } else{
            this.isBusy = false;
        }
    }


    // Call an R-function (constructs and calls the command)
    public callFunction(fnc: RFunctionName, args: any|anyRArgs=[], args2: anyRArgs=[],
        escapeStrings: boolean=true, library: string = this.defaultLibrary,
        force:boolean=false, append: string = this.defaultAppend
    ){
        // two sets of arguments (args and args2) to allow mixing named and unnamed arguments
        const cmd = makeFunctionCall(fnc, args, args2, escapeStrings, library);
        this.runCommand(cmd, [], force, append);
    }

    // Kill the child process
    public killChildProcess(){
        this.cp.kill('SIGKILL');
    }

    public handleData(data: Buffer, from: DataSource){
        var s = data.toString();
        s = s.replace(/\r/g,''); //keep only \n as linebreak

        // console.log("Handle data from " + from + ":", {data: s});

        s = (this.restOfLine[from] || "") + s;

        const lines = s.split(/\n/);
        
        for(var i = 0; i<lines.length; i++){
			// abort output handling if ignoreOutput has been set to true
			// used to avoid handling remaining output after debugging has been stopped
            if(this.ignoreOutput){
                return;
            }
            const isLastLine = i === lines.length-1;
            const line = lines[i];
            var restOfLine: string = "";
            if(isLastLine && line===""){
                restOfLine = "";
            } else if(from === "jsonSocket"){
                restOfLine = this.handleJsonString(lines[i], from, !isLastLine);
            } else{
                restOfLine = this.handleLine(lines[i], from, !isLastLine);
            }
            this.restOfLine[from] = restOfLine;
        }
    }



    // public async handleData2(data: any, fromStderr: boolean = false){
	// 	// handles output from the R child process
	// 	// splits cp.stdout into lines / waits for complete lines
	// 	// calls handleLine() on each line

	// 	const dec = new TextDecoder;
	// 	var s = dec.decode(data);
	// 	s = s.replace(/\r/g,''); //keep only \n as linebreak

	// 	// join with rest text from previous call(s)
	// 	if(fromStderr){
	// 		s = this.restOfStderr + s;
	// 		this.restOfStderr = "";
	// 	} else {
	// 		s = this.restOfStdout + s;
	// 		this.restOfStdout = "";
	// 	}

	// 	// split into lines
	// 	const lines = s.split(/\n/);

	// 	// handle all the complete lines
	// 	for(var i = 0; i<lines.length - 1; i++){
	// 		// abort output handling if ignoreOutput has been set to true
	// 		// used to avoid handling remaining output after debugging has been stopped
    //         if(this.ignoreOutput){ return; }
	// 		this.debugRuntime.handleLine(lines[i], fromStderr, true);
	// 	}

	// 	if(lines.length > 0) {
	// 		// abort output handling if ignoreOutput has been set to true
	// 		if(this.ignoreOutput){ return; }

	// 		// calls this.handleLine on the remainder of the last line
	// 		// necessary, since e.g. an input prompt does not send a newline
	// 		// handleLine returns the parts of a line that were not 'understood'
	// 		const remainingText = await this.debugRuntime.handleLine(lines[lines.length - 1], fromStderr, false);
			
	// 		// remember parts that were no understood for next call
	// 		if(fromStderr){
	// 			this.restOfStderr = remainingText;
	// 		} else {
	// 			this.restOfStdout = remainingText;
	// 		}
	// 	}
    // }
}




function getPortNumber(server: net.Server){
    const address = server.address();
    if (typeof address === 'string' || address === undefined) {
        return -1;
    } else {
        return address.port;
    }
}


/////////////////////////////////
// Child Process

function spawnRProcess(args: RStartupArguments){
    const options = {
        env: {
            VSCODE_DEBUG_SESSION: "1",
            ...process.env
        },
        shell: true
    };

    const rPath = args.path;
    const rArgs = args.args;

    const cp = child.spawn(rPath, rArgs, options);

    const logLevel = args.logLevelCP || 0;
    // log output to console.log:
    if(logLevel>=4){
        cp.stdout.on("data", data => {
            console.log('cp.stdout:\n' + data);
        });
    }
    if(logLevel>=3){
        cp.stderr.on("data", data => {
            console.warn('cp.stderr:\n' + data);
        });
    }
    if(logLevel>=2){
        cp.on("close", code => {
            console.log('Child process exited with code: ' + code);
        });
    }
    if(logLevel>=1){
        cp.on("error", (error) => {
            console.log('cp.error:\n' + error.message);
        });
    }
    return cp;
}
