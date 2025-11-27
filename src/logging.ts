

import * as vscode from 'vscode';


export type SourceName = (
    'stdin' | 'stdout' | 'stderr' | 'dapOut' | 'dapIn' | 'sink' | 'DAP' |
    'info' | 'debug' | 'error' | 'cpinfo' | ''
);

export class Logger {
    srcLength: number = 8;
    
    constructor(
        public outputLine: (txt: string) => void
    ){}
    
    logSingleText(source: SourceName, txt: string): void {
        const lines = txt.replace(/\r/g, '').split('\n');

        const ts = getTimeStamp();
        const src = source.padEnd(this.srcLength, '.');
        
        for(let i = 0; i < lines.length; i++){
            const line = lines[i];
            const isLastLine = (i === lines.length - 1);
            if(isLastLine && line === ''){
                continue;
            }
            const lfInfo = isLastLine ? ' ' : 'n';
            
            this.outputLine(`[${src}] [${ts}] [${lfInfo}] ${line}`);
        }
    }
    
    logText(source: SourceName, ...txt: string[]): void {
        txt.map((t) => this.logSingleText(source, t));
    }
    
    log(source: SourceName, ...msg: any[]): void {
        const txt = msg.map(m => forceString(m));
        this.logText(source, ...txt);
    }
    
    info(...msg: any[]): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.log('info', ...msg);
    }
    debug(...msg: any[]): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.log('debug', ...msg);
    }
    error(...msg: any[]): void {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.log('error', ...msg);
    }
}


function makeVsCodeLogger(): Logger {
    const outputChannel = vscode.window.createOutputChannel('R Debugger');
    const logFunction = (txt: string) => outputChannel.appendLine(txt);
    const logger = new Logger(logFunction);
    return logger;
}



function getTimeStamp(): string {
	const date = new Date();
	const s = date.toISOString().replace(/^.*T(.*)Z$/, '$1');
	return s;
}

function forceString(x: any): string {
    try {
        // x = (<string>x).toString();
    } catch (e) {
        // ignore
    }
    if(typeof x === 'string'){
        return x;
    } else if(x instanceof Buffer){
        return String(x);
    } else if(typeof x === 'object'){
        return JSON.stringify(x);
    } else{
        return String(x);
    }
}

export const logger = makeVsCodeLogger();
