

import * as child from 'child_process';
import { LineHandler, JsonHandler, DataSource } from'./debugRuntime';
import { RStartupArguments } from './debugProtocolModifications';
import { config, getPortNumber } from './utils';
import * as net from 'net';

import { logger } from './logging';

import { Subject } from './subject';
import kill = require('tree-kill');



export class RSession {
    private cp?: child.ChildProcessWithoutNullStreams;
    private handleLine: LineHandler;
    private handleJsonString: JsonHandler;
    private echoStdin: (text: string) => void;
    private restOfLine: {[k in DataSource]?: string} = {};

    public ignoreOutput: boolean = false;

    public host: string = 'localhost';
    public jsonSocket?: net.Socket;
    public sinkSocket?: net.Socket;
    public jsonServer?: net.Server;
    public sinkServer?: net.Server;
    public jsonPort: number = -1;
    public sinkPort: number = -1;

    constructor(
        handleLine: LineHandler,
        handleJson: JsonHandler,
        echoStdin?: (text: string) => void
    ){
        // store line/json handlers (are called by this.handleData)
        this.handleLine = handleLine;
        this.handleJsonString = handleJson;
        this.echoStdin = echoStdin || ((text: string) => {/* dummy */});
    }
    
    public async startR(
        args: RStartupArguments,
    ): Promise<boolean> {
        this.cp = spawnRProcess(args);

        if(this.cp.pid === undefined){
            return false;
        }

		// handle output from the R-process
		this.cp.stdout.on("data", data => {
			this.handleData(data, "stdout");
		});
		this.cp.stderr.on("data", data => {
			this.handleData(data, "stderr");
        });

        // set up json port
        // used for protocol messages, formatted as json
        const jsonPort = args.jsonPort || 0;
        const jsonServerReady = new Subject();

        this.jsonServer = net.createServer((socket) => {
            socket.on('data', (data) => {
                this.handleData(data, 'jsonSocket');
                logger.log('jsonIn', data);
            });
            this.jsonSocket = socket;
        });
        this.jsonServer.listen(jsonPort, this.host, () => {
            this.jsonPort = getPortNumber(this.jsonServer);
            jsonServerReady.notify();
        });

        // set up sink port
        // is used to capture output printed to stdout by 'normal' R commands
        // only some low level stuff (prompt/input echo) is still printed to the actual stdout
        const sinkPort = args.sinkPort || 0;
        const sinkServerReady = new Subject();

        this.sinkServer = net.createServer((socket) => {
            socket.on('data', (data) => {
                this.handleData(data, 'sinkSocket');
                logger.log('sink', data);
            });
            this.sinkSocket = socket;
        });
        this.sinkServer.listen(sinkPort, this.host, () => {
            this.sinkPort = getPortNumber(this.sinkServer);
            sinkServerReady.notify();
        });

        // wait for servers to connect to port
        const timeout = config().get<number>('timeouts.startup', 1000);
        await jsonServerReady.wait(timeout);
        await sinkServerReady.wait(timeout);

        return true;
    }

    public writeToStdin(text: string, checkNewLine: boolean = true): void {
        // make sure text ends in exactly one newline
        if(checkNewLine){
            text = text.replace(/\n*$/,'\n');
        }

        // log and write text
        this.echoStdin(text);
        logger.log('stdin', text);
        this.cp?.stdin.write(text);
        if(!this.cp){
            logger.error('No child process available');
        }
    }
    public writeToJsonSocket(text: string): void {
        this.jsonSocket?.write(text);
        logger.log('jsonOut', text);
        if(!this.jsonSocket){
            logger.error('No Json socket available');
        }

    }

    // Kill the child process
    public killChildProcess(signal = 'SIGKILL'): void{
        if(!this.cp){
            // logger.info('No child process to kill');
        } else if(this.cp.exitCode === null){
            logger.log('cpinfo', `sending signal ${signal}...`);
            kill(this.cp.pid, signal);
            logger.log('cpinfo', 'sent signal');
        } else{
            logger.log('cpinfo', `process already exited with code ${this.cp.exitCode}`);
        }
    }

    public handleData(data: Buffer, from: DataSource): void{

        let text: string = data.toString();
        text = text.replace(/\r/g,''); //keep only \n as linebreak
        text = (this.restOfLine[from] || "") + text; // append to rest of line from previouse call
        const lines = text.split(/\n/); // split into lines

        // logger.debug(`data from ${from}: ${text}`);
        
        for(let i = 0; i<lines.length; i++){
			// abort output handling if ignoreOutput has been set to true
			// used to avoid handling remaining output after debugging has been stopped
            if(this.ignoreOutput){
                return;
            }
            const isLastLine = i === lines.length-1;
            const line = lines[i];
            let restOfLine: string;
            if(isLastLine && line === ""){
                restOfLine = "";
            } else if(from === "jsonSocket"){
                restOfLine = this.handleJsonString(line, from, !isLastLine);
            } else{
                restOfLine = this.handleLine(line, from, !isLastLine);
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
            ...args.env,
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
        logger.log('stdout', data);
    });
    cp.stderr.on("data", data => {
        logger.log('stderr', data);
    });
    cp.on("close", code => {
        logger.log('cpinfo', `Child process exited with code: ${code}`);
    });
    cp.on("error", error => {
        logger.log('cpinfo', `cp.error:${error.message}`);
    });
    return cp;
}
