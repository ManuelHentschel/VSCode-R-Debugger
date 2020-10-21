

import * as child from 'child_process';
import { LineHandler, JsonHandler, DataSource } from'./debugRuntime';
import { RStartupArguments } from './debugProtocolModifications';
import { config, getPortNumber } from './utils';
import * as net from 'net';

const { Subject } = require('await-notify');
const kill = require('tree-kill');

import * as log from 'loglevel';
const logger = log.getLogger("RSession");


export class RSession {
    private cp: child.ChildProcessWithoutNullStreams;
    private handleLine: LineHandler;
    private handleJsonString: JsonHandler;
    private restOfLine: {[k in DataSource]?: string} = {};

    public ignoreOutput: boolean = false;

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

        // store line/json handlers (are called by this.handleData)
        this.handleLine = handleLine;
        this.handleJsonString = handleJson;

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

    public writeToStdin(text: string, checkNewLine: boolean = true){
        // make sure text ends in exactly one newline
        if(checkNewLine){
            while(text.length>0 && text.slice(-1) === '\n'){
                text = text.slice(0, -1);
            }
            text = text + '\n';
        }

        // log and write text
        logger.info('cp.stdin:\n' + text.trim());
        this.cp.stdin.write(text);
    }

    // Kill the child process
    public killChildProcess(signal = 'SIGKILL'){
        if(this.cp.exitCode === null){
            logger.info('sending signal' + signal + '...');
            kill(this.cp.pid, signal);
            logger.info('sent signal');
        } else{
            logger.info('process already exited with code ' + this.cp.exitCode);
        }
    }

    public handleData(data: Buffer, from: DataSource){

        let text: string = data.toString();
        text = text.replace(/\r/g,''); //keep only \n as linebreak
        text = (this.restOfLine[from] || "") + text; // append to rest of line from previouse call
        const lines = text.split(/\n/); // split into lines

        logger.debug(`data from ${from}: ${text}`);
        
        for(let i = 0; i<lines.length; i++){
			// abort output handling if ignoreOutput has been set to true
			// used to avoid handling remaining output after debugging has been stopped
            if(this.ignoreOutput){
                return;
            }
            const isLastLine = i === lines.length-1;
            const line = lines[i];
            let restOfLine: string = "";
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
