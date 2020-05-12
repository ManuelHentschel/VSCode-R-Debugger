

import * as child from 'child_process';

export class RSession {
    public cp: child.ChildProcessWithoutNullStreams;

    constructor(terminalPath:string, rPath: string, cwd: string, rArgs: string[]=[]) {
        // spawn new terminal process (necessary for interactive R session)
        this.cp = spawnChildProcess(terminalPath, cwd)

        // start R in terminal process
        this.runCommand(rPath, rArgs)
    }

    public runCommand(cmd: string, args: (string|number)[]=[]){
        // remove trailing newline
		if(cmd.slice(-1) === '\n'){
            cmd = cmd.slice(0, -1);
        }

        // append arguments (if any given)
        if(args.length > 0){
            cmd = cmd + ' ' + args.join(' ') + '\n';
        } else {
            cmd = cmd + '\n';
        }

        // execute and log command
		this.cp.stdin.write(cmd);
		console.log('stdin:\n' + cmd.trim());
    }
    public callFunction(fnc: string, args: ((string|number)[] | {[arg:string]: (string|number)})=[]){
        // if necessary, convert args form object-form to array, save to args2 to have a unamibuous data type
        var args2: (string|number)[] = [];
        if(Array.isArray(args)){
            args2 = args;
        } else {
            for(const arg in args){
                args2.push(arg + '=' + args[arg]);
            }
        }
        // construct and execute function-call
        const cmd = fnc + '(' + args2.join(',') + ')';
        this.runCommand(cmd);
    }
}





function spawnChildProcess(terminalPath: string, cwd: string, cmdArgs: string[]=[]) {
    const options = {
        cwd: cwd
    };
    // const cmdTerminal = getRpath()
    // const cmdArgs = ['--no-save', '--quiet', '--interactive']
    const cp = child.spawn(terminalPath, cmdArgs, options);
    // const Rpath = '"C:\\Program Files\\R\\R-3.6.1\\bin\\R.exe"';
    // const cp = child.spawn(Rpath, ['--no-save', '--interactive'], options)
    // console.log("Spawned Process with PID: " + cp.pid);
    // const cp = child.spawn("cmd", ['/K', 'Rterminal', '--no-save']);


    // log output to console.log:
    cp.stdout.on("data", data => {
        console.log('stdout:\n' + data);
    });
    cp.stderr.on("data", data => {
        console.warn('stderr:\n' + data);
    });
    cp.on("error", (error) => {
        console.log('error:\n' + error.message);
    });
    cp.on("close", code => {
        console.log('Child process exited with code: ' + code);
    });
    return cp;
}

export function toRStringLiteral(s: string, quote: string='"') {
    if (s === undefined) {
        return "NULL";
    } else {
        return (quote +
            s.replace(/\\/g, "\\\\")
                .replace(/"""/g, `\\${quote}`)
                .replace(/\\n/g, "\\n")
                .replace(/\\r/g, "\\r")
                .replace(/\\t/g, "\\t")
                .replace(/\\b/g, "\\b")
                .replace(/\\a/g, "\\a")
                .replace(/\\f/g, "\\f")
                .replace(/\\v/g, "\\v") +
            quote);
    }
}