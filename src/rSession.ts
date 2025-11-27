

import * as child from 'child_process';
import { LineHandler, DataSource, DapHandler } from'./debugRuntime';
import { RStartupArguments } from './debugProtocolModifications';
import { config, getPortNumber } from './utils';
import * as net from 'net';

import { logger } from './logging';

import { Subject } from './subject';
import kill = require('tree-kill');



export class RSession {
    private cp?: child.ChildProcessWithoutNullStreams;
    private handleLine: LineHandler;
    private handleDapData: DapHandler;
    private echoStdin: (text: string) => void;
    private restOfLine: {[k in DataSource]?: string} = {};
    private restOfDap: Buffer = Buffer.from('');

    public ignoreOutput: boolean = false;

    public host: string = 'localhost';
    public dapSocket?: net.Socket;
    public sinkSocket?: net.Socket;
    public dapServer?: net.Server;
    public sinkServer?: net.Server;
    public dapPort: number = -1;
    public sinkPort: number = -1;

    constructor(
        handleLine: LineHandler,
        handleDapData: DapHandler,
        echoStdin?: (text: string) => void
    ){
        // store line/json handlers (are called by this.handleData)
        this.handleLine = handleLine;
        this.handleDapData = handleDapData;
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
		this.cp.stdout.on('data', data => {
			this.handleData(data, 'stdout');
		});
		this.cp.stderr.on('data', data => {
			this.handleData(data, 'stderr');
        });

        // set up json port
        // used for protocol messages, formatted as json
        const dapPort = args.dapPort || 0;
        const dapServerReady = new Subject();

        this.dapServer = net.createServer((socket) => {
            socket.on('data', (data) => {
                this.handleData(data, 'dapSocket');
                logger.log('dapIn', data);
            });
            this.dapSocket = socket;
        });
        this.dapServer.listen(dapPort, this.host, () => {
            this.dapPort = getPortNumber(this.dapServer);
            dapServerReady.notify();
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
        await dapServerReady.wait(timeout);
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
    public writeToDapSocket(text: string): void {
        this.dapSocket?.write(text);
        logger.log('dapOut', text);
        if(!this.dapSocket){
            logger.error('No DAP socket available');
        }
    }

    // Kill the child process
    public killChildProcess(signal = 'SIGKILL'): void{
        const pid = this.cp?.pid;
        if(!this.cp){
            // logger.info('No child process to kill');
        } else if(this.cp.exitCode === null){
            const pid = this.cp.pid;
            if(pid === undefined){
                logger.log('cpinfo', 'No pid found for child process');
            } else{
                logger.log('cpinfo', `sending signal ${signal}...`);
                kill(pid, signal);
                logger.log('cpinfo', 'sent signal');
            }
        } else{
            logger.log('cpinfo', `process already exited with code ${this.cp.exitCode}`);
        }
    }

    public handleData(data: Buffer, from: DataSource): void{

        // logger.debug(`data from ${from}: ${text}`);
        // 
        if(from === 'dapSocket'){
            data = Buffer.concat([this.restOfDap, data]);
            const restOfLine = this.handleDapData(data);
            this.restOfDap = restOfLine;
            return;
        }
        

        let text: string = data.toString();
        // text = text.replace(/\r/g,''); //keep only \n as linebreak
        text = (this.restOfLine[from] || '') + text; // append to rest of line from previouse call
        const lines = text.split(/\n/); // split into lines

        for(let i = 0; i<lines.length; i++){
            // abort output handling if ignoreOutput has been set to true
            // used to avoid handling remaining output after debugging has been stopped
            if(this.ignoreOutput){
                return;
            }
            const isLastLine = i === lines.length-1;
            const line = lines[i];
            let restOfLine: string;
            if(isLastLine && line === ''){
                restOfLine = '';
            // } else if(from === 'dapSocket'){
                // restOfLine = this.handleDapString(line, from, !isLastLine);
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
            VSCODE_DEBUG_SESSION: '1',
            ...process.env,
            ...args.env
        },
        shell: true,
        cwd: args.cwd
    };

    const rPath = args.path;
    const rArgs = args.args;

    const cp = child.spawn(rPath, rArgs, options);

    // log output
    cp.stdout.on('data', data => {
        logger.log('stdout', data);
    });
    cp.stderr.on('data', data => {
        logger.log('stderr', data);
    });
    cp.on('close', code => {
        logger.log('cpinfo', `Child process exited with code: ${code}`);
    });
    cp.on('error', error => {
        logger.log('cpinfo', `cp.error:${error.message}`);
    });
    return cp;
}
