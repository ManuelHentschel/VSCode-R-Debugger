

import * as child from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { isUndefined, isBoolean, isNumber, isArray, isObject } from 'util';

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export type unnamedRArg = (number|string|boolean);
export type unnamedRArgs = unnamedRArg[];
export type namedRArgs = {[arg:string]: unnamedRArg};
export type anyRArgs = (unnamedRArg|unnamedRArgs|namedRArgs);

export class RSession {
    public cp: child.ChildProcessWithoutNullStreams;
    public isBusy: boolean = false;
    public useQueue: boolean = false;
    public cmdQueue: string[] = [];
    public readonly logStream: fs.WriteStream;
    public logLevel: number = 3;
    public readonly logLevelCP: number = 4;
    public waitBetweenCommands: number = 0;
    public defaultLibrary: string = '';
    public readonly successTerminal: boolean = false;

    constructor(terminalPath:string, rPath: string, cwd: string, rArgs: string[]=[], logLevel=undefined, logLevelCP=undefined) {
        // spawn new terminal process (necessary for interactive R session)

        if(!logLevel === undefined){
            this.logLevel = logLevel;
        }
        if(!logLevelCP === undefined){
            this.logLevelCP = logLevelCP;
        }


        this.cp = spawnChildProcess(terminalPath, cwd, [], this.logLevelCP)

        if(this.cp.pid === undefined){
            return;
        }

        // start R in terminal process
        this.runCommand(rPath, rArgs)

        // vscode.window.showErrorMessage('R path not valid!');
        // return;

        this.successTerminal = true;
    }

    public async runCommand(cmd: string, args: (string|number)[]=[], force=false){
        // remove trailing newline
		while(cmd.length>0 && cmd.slice(-1) === '\n'){
            cmd = cmd.slice(0, -1);
        }

        // append arguments (if any given)
        if(args.length > 0){
            cmd = cmd + ' ' + args.join(' ') + '\n';
        } else {
            cmd = cmd + '\n';
        }

        // execute command or add to command queue
        if(!force && this.useQueue && this.isBusy){
            this.cmdQueue.push(cmd);
            if(this.logLevel>=3){
                console.log('rSession: stored command "' + cmd.trim() + '" to position ' + this.cmdQueue.length);
            }
        } else{
            this.isBusy = true;
            if(this.waitBetweenCommands>0){
                await timeout(this.waitBetweenCommands);
            }
            this.cp.stdin.write(cmd);
            if(this.logLevel>=3){
                console.log('cp.stdin:\n' + cmd.trim());
            }
        }

    }

    public clearQueue(){
        this.cmdQueue = [];
    }

    // Call this function to indicate that the previous command is done and the R-Process idle:
    public showsPrompt(){
        if(this.cmdQueue.length>0){
            this.isBusy = true;
            const cmd = this.cmdQueue.shift();
            console.log('rSession: calling from list: "' + cmd.trim() + '"');
            this.runCommand(cmd, [], true);
        } else{
            this.isBusy = false;
        }
    }

    // Call an R-function (constructs and calls the command)
    // public callFunction(fnc: string, args: ((string|number)[] | {[arg:string]: (string|number|boolean)})=[], library: string = this.defaultLibrary){
    public callFunction(fnc: string, args: anyRArgs=[], args2: anyRArgs=[], library: string = this.defaultLibrary){
        const cmd = makeFunctionCall(fnc, args, args2, library)
        this.runCommand(cmd);
    }

    // Kill the child process
    public killChildProcess(){
        this.cp.kill('SIGKILL');
    }
}


export function makeFunctionCall(fnc: string, args: anyRArgs=[], args2: anyRArgs=[], library: string = ''): string{
    // if necessary, convert args form object-form to array, save to args2 to have a unambiguous data type
    args = convertToUnnamedArgs(args);
    args2 = convertToUnnamedArgs(args2);
    args = args.concat(args2)
    const argString = unnamedRArgsToString(args)

    if(library != ''){
        library = library + '::'
    }

    // construct and execute function-call
    const cmd = library + fnc + '(' + argString + ')';
    return cmd;
}


function convertToUnnamedArgs(args: anyRArgs): unnamedRArgs{
    var ret: unnamedRArgs
    if(isArray(args)){
        ret = <unnamedRArgs>args;
    } else if(isObject(args)){
        ret = [];
        for(const arg in <namedRArgs>args){
            ret.push(arg + '=' + unnamedRArgToString(args[arg]))
        }
    } else{
        ret = [<unnamedRArg>args]
    }
    return ret;
}

function unnamedRArgsToString(args: unnamedRArgs): string{
    return args.map(unnamedRArgToString).join(',')
}

function unnamedRArgToString(arg: unnamedRArg): string{
    var ret: string;
    if(typeof arg === 'boolean'){
        if(arg){
            ret = 'TRUE';
        } else{
            ret = 'FALSE';
        }
    } else {
        ret = '' + arg;
    }
    return ret;
}



function spawnChildProcess(terminalPath: string, cwd: string, cmdArgs: string[]=[], logLevel=3){
    const options = {
        cwd: cwd
    };
    const cp = child.spawn(terminalPath, cmdArgs, options);

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