

import * as child from 'child_process';
import { TextDecoder } from 'util';
import { DebugRuntime } from'./debugRuntime';

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export type unnamedRArg = (number|string|boolean|undefined);
export type unnamedRArgs = (unnamedRArg|rList)[];
export type namedRArgs = {[arg:string]: unnamedRArg|rList};
export type rList = (unnamedRArgs|namedRArgs);
export type anyRArgs = (unnamedRArg|unnamedRArgs|namedRArgs);


export class RSession {
    public cp: child.ChildProcessWithoutNullStreams;
    public isBusy: boolean = false;
    public useQueue: boolean = false;
    public cmdQueue: string[] = [];
    public logLevel: number = 3;
    public readonly logLevelCP: number = 4;
    public waitBetweenCommands: number = 0;
    public defaultLibrary: string = '';
    public defaultAppend: string = '';
    public readonly successTerminal: boolean = false;
    public ignoreOutput: boolean=false;
    public readonly debugRuntime: DebugRuntime;
    private restOfStderr: string='';
    private restOfStdout: string='';


    constructor(rPath: string, cwd: string, rArgs: string[]=[],
        // handleLine: (line:string,fromStderr:boolean,isFullLine:boolean)=>(Promise<string>),
        debugRuntime: DebugRuntime,
        logLevel=undefined, logLevelCP=undefined)
    {
        // spawn new terminal process (necessary for interactive R session)

        if(!logLevel === undefined){
            this.logLevel = logLevel;
        }
        if(!logLevelCP === undefined){
            this.logLevelCP = logLevelCP;
        }

        this.cp = spawnRProcess(rPath, cwd, rArgs, this.logLevelCP);

        if(this.cp.pid === undefined){
            this.successTerminal = false;
            return;
        }

        // store line handler
        // is only used for debugRuntim.handleLine()
        this.debugRuntime = debugRuntime;

		// handle output from the R-process
		this.cp.stdout.on("data", data => {
			this.handleData(data, false);
		});
		this.cp.stderr.on("data", data => {
			this.handleData(data, true);
		});


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
            console.log('rSession: calling from list: "' + cmd.trim() + '"');
            this.runCommand(cmd, [], true, '');
        } else{
            this.isBusy = false;
        }
    }


    // Call an R-function (constructs and calls the command)
    public callFunction(fnc: string, args: any|anyRArgs=[], args2: anyRArgs=[],
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

    public async handleData(data: any, fromStderr: boolean = false){
		// handles output from the R child process
		// splits cp.stdout into lines / waits for complete lines
		// calls handleLine() on each line

		const dec = new TextDecoder;
		var s = dec.decode(data);
		s = s.replace(/\r/g,''); //keep only \n as linebreak

		// join with rest text from previous call(s)
		if(fromStderr){
			s = this.restOfStderr + s;
			this.restOfStderr = "";
		} else {
			s = this.restOfStdout + s;
			this.restOfStdout = "";
		}

		// split into lines
		const lines = s.split(/\n/);

		// handle all the complete lines
		for(var i = 0; i<lines.length - 1; i++){
			// abort output handling if ignoreOutput has been set to true
			// used to avoid handling remaining output after debugging has been stopped
            if(this.ignoreOutput){ return; }
			this.debugRuntime.handleLine(lines[i], fromStderr, true);
		}

		if(lines.length > 0) {
			// abort output handling if ignoreOutput has been set to true
			if(this.ignoreOutput){ return; }

			// calls this.handleLine on the remainder of the last line
			// necessary, since e.g. an input prompt does not send a newline
			// handleLine returns the parts of a line that were not 'understood'
			const remainingText = await this.debugRuntime.handleLine(lines[lines.length - 1], fromStderr, false);
			
			// remember parts that were no understood for next call
			if(fromStderr){
				this.restOfStderr = remainingText;
			} else {
				this.restOfStdout = remainingText;
			}
		}
    }
}



/////////////////////////////////////////////////
// Construction of R function calls

export function makeFunctionCall(
    fnc: string, args: anyRArgs=[], args2: anyRArgs=[],
    escapeStrings: boolean=true, library: string = '', append: string = ''
): string{
    // args and args2 are handled identically and only necessary when combining named and unnamed arguments
    args = convertToUnnamedArgs(convertArgsToStrings(args, escapeStrings));
    args2 = convertToUnnamedArgs(convertArgsToStrings(args2, escapeStrings));
    args = args.concat(args2);
    const argString = args.join(',');

    if(library !== ''){
        library = library + '::';
    }

    // construct and execute function-call
    const cmd = library + fnc + '(' + argString + ')' + append;
    return cmd;
}

function convertArgsToStrings(args:anyRArgs=[], escapeStrings:boolean = false): anyRArgs {
    // Recursively converts all atomic arguments to strings, without changing the structure of arrays/lists
    if(Array.isArray(args)){
        //unnamedRArgs
        args = args.map((arg) => convertArgsToStrings(arg, escapeStrings));
    } else if(args!==null && typeof args === 'object'){
        //namedRArgs
        const ret = {};
        for(const arg in <namedRArgs>args){
            if(arg.substr(0,2)==='__'){
                console.warn('Ignoring argument: ' + arg);
            } else{
                ret[arg] = convertArgsToStrings(args[arg], escapeStrings);
            }
        }
        args = ret;
    } else if(args === undefined){
        //undefined
        args = 'NULL';
    } else if(typeof args === 'boolean'){
        //boolean
        if(args){
            args = 'TRUE';
        } else{
            args = 'FALSE';
        }
    } else if(typeof args === 'number'){
        //number
        args = '' + args;
    } else {
        //string
        if(escapeStrings){
            args = escapeStringForR(<string>args);
        }
    }
    return(args);
}

export function escapeStringForR(s: string, quote: string='"') {
    if (s === undefined) {
        return "NULL";
    } else {
        return(
            quote
            + s.replace(/\\/g, "\\\\")
                .replace(RegExp(quote, "g"), `\\${quote}`)
                .replace(/\n/g, "\\n")
                // .replace(/\r/g, "\\r")
                .replace(/\r/g, "")
                .replace(/\t/g, "\\t")
                .replace(/\f/g, "\\f")
                .replace(/\v/g, "\\v")
            + quote);
    }
}

function convertToUnnamedArgs(args: anyRArgs): unnamedRArgs{
    // converts anyRArgs to unnamed args by recursively converting named args "{key: arg}" to "key=arg"
    var ret: unnamedRArgs;
    if(Array.isArray(args)){
        // might be a nested list -> call recursively
        ret = args.map(convertToUnnamedArg);
    } else if(args!==null && typeof args === 'object'){
        ret = [];
        for(const arg in <namedRArgs>args){
            // again, each args[arg] might be a list itself
            ret.push(arg + '=' + convertToUnnamedArg(args[arg]));
        }
    } else{
        ret = [<unnamedRArg>args];
    }
    return ret;
}

function convertToUnnamedArg(arg: unnamedRArg|rList): unnamedRArg{
    // recursively converts an array of arguments to a single argument by turning it into a call to base::list()
    var ret: unnamedRArg;
    if(Array.isArray(arg)){
        // is rList
        ret = makeFunctionCall('list', arg, [], false,'base', '');
    } else if(arg!==null && typeof arg === 'object'){
        ret = makeFunctionCall('list', arg, [], false, 'base', '');
    } else{
        ret = <unnamedRArg>arg;
    }
    return ret;
}




/////////////////////////////////
// Child Process

function spawnRProcess(rPath: string, cwd: string, rArgs: string[] = [], logLevel=3){
    const options = {
        cwd: cwd,
        env: {
            VSCODE_DEBUG_SESSION: "1",
            ...process.env
        },
        shell: true
    };

    const cp = child.spawn(rPath, rArgs, options);

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
