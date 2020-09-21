

import * as child from 'child_process';
import { TextDecoder } from 'util';
import { LineHandler, JsonHandler, DataSource } from'./debugRuntime';
import { RStartupArguments } from './debugProtocolModifications';
import { makeFunctionCall, anyRArgs } from './rUtils';
import { config, getPortNumber } from './utils';
import * as net from 'net';
const { Subject } = require('await-notify');
const kill = require('tree-kill');

import * as log from 'loglevel';
const logger = log.getLogger("RSession");

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
    ".vsc.listenOnPort" |
    "install.packages"
);


export class RSession {
    public cp: child.ChildProcessWithoutNullStreams;
    public waitBetweenCommands: number = 0;
    public defaultLibrary: string = '';
    public ignoreOutput: boolean=false;
    private handleLine: LineHandler;
    private handleJsonString: JsonHandler;
    private restOfLine: {[k in DataSource]?: string} = {};

    public host: string = 'localhost';
    public jsonSocket: net.Socket;
    public sinkSocket: net.Socket;
    public jsonServer: net.Server;
    public sinkServer: net.Server;
    public jsonPort: number = -1;
    public sinkPort: number = -1;


    constructor(){
		logger.setLevel(config().get<log.LogLevelDesc>('logLevelRSession', 'silent'));
    };
    
    public async startR(args: RStartupArguments, handleLine: LineHandler, handleJson: JsonHandler): Promise<boolean> {
        this.cp = spawnRProcess(args);

        if(this.cp.pid === undefined){
            return false;
        }

        this.handleLine = handleLine;
        this.handleJsonString = handleJson;

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

        return true;
    }

    public async runCommand(cmd: string, args: (string|number)[]=[], force=false){
        // remove trailing newline
		while(cmd.length>0 && cmd.slice(-1) === '\n'){
            cmd = cmd.slice(0, -1);
        }


        // append arguments (if any given) and newline
        if(args.length > 0){
            cmd = cmd + ' ' + args.join(' ') + '\n';
        } else {
            cmd = cmd + '\n';
        }

        // execute command or add to command queue
        if(this.waitBetweenCommands>0){
            await timeout(this.waitBetweenCommands);
        }
        logger.info('cp.stdin:\n' + cmd.trim());
        this.cp.stdin.write(cmd);
    }

    // Call an R-function (constructs and calls the command)
    public callFunction(
        fnc: RFunctionName,
        args: any|anyRArgs=[],
        args2: anyRArgs=[],
        escapeStrings: boolean=true,
        library: string = this.defaultLibrary,
        force:boolean=false
    ){
        // two sets of arguments (args and args2) to allow mixing named and unnamed arguments
        const cmd = makeFunctionCall(fnc, args, args2, escapeStrings, library);
        this.runCommand(cmd, [], force);
    }

    // Kill the child process
    public killChildProcess(){
        console.log('sending sigkill...');
        // this.cp.kill();
        kill(this.cp.pid, 'SIGKILL');
        console.log('sent sigkill');
    }

    public handleData(data: Buffer, from: DataSource){
        var s = data.toString();
        s = s.replace(/\r/g,''); //keep only \n as linebreak

        s = (this.restOfLine[from] || "") + s; // append to rest of line from previouse call

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
            this.restOfLine[from] = restOfLine; // save unhandled part for next call
        }
    }
}

/////////////////////////////////
// Child Process

function spawnRProcess(args: RStartupArguments){
    const options: child.SpawnOptionsWithoutStdio = {
        env: {
            VSCODE_DEBUG_SESSION: "1",
            ...process.env
        },
        shell: true,
        cwd: args.cwd
    };

    const rPath = args.path;
    const rArgs = args.args;

    const cp = child.spawn(rPath, rArgs, options);

    // log output
    cp.stdout.on("data", data => {
        logger.debug('cp.stdout:\n' + data);
    });
    cp.stderr.on("data", data => {
        logger.debug('cp.stderr:\n' + data);
    });
    cp.on("close", code => {
        logger.debug('Child process exited with code: ' + code);
    });
    cp.on("error", (error) => {
        logger.debug('cp.error:\n' + error.message);
    });
    return cp;
}
