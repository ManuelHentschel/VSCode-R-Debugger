

/*
The functions in this file are only used when debugging in attached mode.


This file contains functions to answer the custom request
`writeToStdinRequest`
which is used by the R package vscDebugger to request text written to its stdin.

This approach is used, since there are no R functions to replace e.g.
`n`, `f`, `c`
when using the browser() prompt.

Therefore, there is no way for the R package to continue execution or step
through code by itself (as far as I'm aware).

This problem can be solved to some extent by the R package requesting text
like the commands mentioned above to its stdin.

This approach is a bit hacky but seems to work fine in simple usecases.
If the user is using the terminal at the same time, things probably get messy.
*/




import * as net from 'net';
import * as vscode from 'vscode';
import { WriteToStdinEvent, WriteToStdinBody } from './debugProtocolModifications';
import { config, getPortNumber } from './utils';

import { logger } from './logging';

let doTrackTerminals: boolean = false;


export function trackTerminals(envCol: vscode.EnvironmentVariableCollection): void{

    let terminalId = 1;
    
    function getAndUpdateTerminalId(): string {
        const oldId = `${terminalId}`;
        terminalId += 1;
        envCol.replace('VSCODE_R_DEBUGGER_TERMINAL_ID', `${terminalId}`);
        return oldId;
    }

    // initialize the EnvironmentVariableMutator
    getAndUpdateTerminalId();

	vscode.window.onDidOpenTerminal((term: vscode.Terminal) => {
		(<TerminalWithTerminalId>term).vscodeRDebuggerTerminalId = getAndUpdateTerminalId();
		return null;
    });

    doTrackTerminals = true;
}


interface WriteToStdinArgs {
    text: string;
    addNewLine: boolean;
    count: number;
    terminalId: string;
    useActiveTerminal: boolean;
    pid: number;
    ppid: number;
}

interface TerminalWithTerminalId extends vscode.Terminal {
    vscodeRDebuggerTerminalId?: string;
}

export class TerminalHandler {

    readonly portPromise: Promise<number>;

    private server: net.Server;
    private lineCache = new Map<net.Socket, string | undefined>();

    public constructor(port: number = 0, host: string = 'localhost'){
        const timeout = config().get<number>('timeouts.startup', 1000);
        this.server = net.createServer((socket) => {
            logger.debug('Custom server: connection!');
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

    public dispose(): void {
        logger.info('Closing custom server connections');
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

        for(const line of lines){
            const j = <{[key: string]: any}>JSON.parse(line);
            void this.handleJson(j);
        }
    }

    private handleJson(json: WriteToStdinEvent|{[key: string]: any}): (Promise<boolean>|boolean){
        if(json.type === 'event' && json.event === 'custom'){
            const body = <Partial<WriteToStdinBody> | undefined> json.body;
            if(body?.reason === 'writeToStdin'){
                body.terminalId = body.terminalId || '0';
                body.useActiveTerminal = body.useActiveTerminal || false;
                body.text = body.text || '';
                body.addNewLine = body.addNewLine || true;
                if(body.count !== 0){
                    body.count = body.count || 1;
                }
                body.pid = body.pid || 0;
                body.ppid = body.ppid || 0;
                if(body.when === 'now' || body.fallBackToNow){
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
            const pid = await term.processId;
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

