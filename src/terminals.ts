

import * as net from 'net';

import { WriteToStdinEvent, WriteToStdinBody } from './debugProtocolModifications';
import * as vscode from 'vscode';
import { config, getPortNumber } from './utils';

import * as log from 'loglevel';
const logger = log.getLogger("DebugRuntime");
logger.setLevel(config().get<log.LogLevelDesc>('logLevelTerminals', 'INFO'));

let doTrackTerminals: boolean = false;

export function trackTerminals(){
    const platform: string = process.platform;
    const terminalEnvSetting: string = "terminal.integrated.env";
    let platformString: string;
    if(platform === "win32"){
        platformString = "windows";
    } else if(platform === "darwin"){
        platformString = "osx";
    } else if(platform === "linux"){
        platformString = "linux";
    } else{
        // abort
        return false;
    }

    function getAndUpdateTerminalId(): string {
		const config = vscode.workspace.getConfiguration(terminalEnvSetting);
		const envVars = config.get<{VSCODE_R_DEBUGGER_TERMINAL_ID?: string}>(platformString, {});
		const oldId = envVars.VSCODE_R_DEBUGGER_TERMINAL_ID;
		const newId = (Number(oldId) || 1) + 1;
		envVars.VSCODE_R_DEBUGGER_TERMINAL_ID = '' + newId;
		config.update(
			platformString,
			envVars,
			false
        );
        return(oldId);
    }

	vscode.window.onDidOpenTerminal((term: vscode.Terminal) => {
		(<TerminalWithTerminalId>term).vscodeRDebuggerTerminalId = getAndUpdateTerminalId();
		return null;
    });

    doTrackTerminals = true;

    getAndUpdateTerminalId();

    return true;
}

interface WriteToStdinArgs {
    text: string;
    addNewLine: boolean;
    count: number;
    terminalId: string;
    useActiveTerminal: boolean;
    pid: number;
    ppid: number;
};

interface TerminalWithTerminalId extends vscode.Terminal {
    vscodeRDebuggerTerminalId?: string;
}

export class TerminalHandler {

    public port: number;
    readonly portPromise: Promise<number>;
    readonly host: string;

    private server: net.Server;
    private lineCache = new Map<net.Socket, string>();

    public constructor(port: number = 0, host: string = 'localhost'){
        const timeout = config().get<number>('timeouts.startup', 1000);
        this.server = net.createServer((socket) => {
            logger.debug('Cusotm server: connection!');
            socket.on('data', (data) => {
                this.handleData(data, socket);
            });
        });
        const portPromise = new Promise<number>((resolve, reject) => {
            this.server.listen(port, host, () => {
                const port = getPortNumber(this.server);
                logger.info(`Custom server listening on ${host}:${port}`);
                resolve(port);
            });
            setTimeout(() => {
                reject(new Error('Server not listening...'));
            }, timeout);
        });

        this.portPromise = portPromise;
    }

    public close(){
        console.log('Closing custom server connections');
        this.lineCache.forEach((_, socket) => {
            socket.destroy();
        });
        this.server.close();
    }

    private handleData(data: Buffer, socket: net.Socket){
        const newText: string = data.toString().replace(/\r/g, '');
        const restOfLine = this.lineCache.get(socket) || '';
        const text = restOfLine + newText;
        const lines = text.split('\n');

        this.lineCache.set(socket, lines.pop());

        for(let line of lines){
            const j = JSON.parse(line);
            this.handleJson(j);
        }
    }

    private handleJson(json: WriteToStdinEvent|any): (Promise<boolean>|boolean){
        if(json.type === 'event' && json.event === 'custom'){
            if(json.body && json.body.reason === 'writeToStdin'){
                const body: WriteToStdinBody = json.body;
                body.terminalId = body.terminalId || '0';
                body.useActiveTerminal = body.useActiveTerminal || false;
                body.text = body.text || '';
                body.addNewLine = body.addNewLine || true;
                if(body.count !== 0){
                    body.count = body.count || 1;
                }
                body.pid = body.pid || 0;
                body.ppid = body.ppid || 0;
                if(body.when === "now" || body.fallBackToNow){
                    // make sure, all mandatory fields are assigned above!
                    return writeToStdin(<WriteToStdinArgs>body);
                } else{
                    return false;
                }
            }
        }
        return false;
    }
}

async function writeToStdin(args: WriteToStdinArgs){
    const terminal = await findTerminal(args);
    if(terminal){
        terminal.sendText(args.text, args.addNewLine);
        return true;
    } else{
        logger.debug('No terminal found.');
        return false;
    }
}

async function findTerminal(args: WriteToStdinArgs): Promise<vscode.Terminal|undefined> {
    // abort if no terminals open
    if(vscode.window.terminals.length < 1){
        return undefined;
    }
    let term: TerminalWithTerminalId;
    // try looking by pid / parent pid
    if(args.pid>0 || args.ppid>0){
        for(term of vscode.window.terminals){
            const pid: number = await term.processId;
            if(pid === args.pid || pid === args.ppid){
                logger.debug('identified terminal by pid');
                return term;
            }
        }
    }
    // try looking by terminal id (added on terminal creation by the extension)
    if(args.terminalId && doTrackTerminals){
        for(term of vscode.window.terminals){
            if('vscodeRDebuggerTerminalId' in term && args.terminalId === term.vscodeRDebuggerTerminalId){
                logger.debug('identified terminal by terminalId');
                return term;
            }
        }
    }
    // resort to active terminal
    if(args.useActiveTerminal){
        logger.debug('resort to active terminal');
        return vscode.window.activeTerminal;
    }
    // give up...
    return undefined;
}

