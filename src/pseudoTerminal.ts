
import * as child from 'child_process';
import * as vscode from 'vscode';
import { getRPath, getTerminalPath } from './rUtils';


// var pty:vscode.Pseudoterminal = {
//     onDidWrite = new Event<string> 
// };
//  implements vscode.Pseudoterminal;


export function createPseudoTerminal(inputHandler: (data: any) => any, writeEmitter: vscode.EventEmitter<string>){
    // Example: Exit the terminal when "y" is pressed, otherwise show a notification. ```
    // typescript
    const closeEmitter = new vscode.EventEmitter<number>();
    const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        // open: () => writeEmitter.fire('>'),
        open: () => {},
        close: () => {
            console.log('PseudoTerminal closed');
        },
        handleInput: data => {
            writeEmitter.fire(data === '\r' ? '\r\n' : data);
            inputHandler(data === '\r' ? '\n' : data);
            // if (data !== 'y') { vscode.window.showInformationMessage('Something went wrong'); } closeEmitter.fire();
        }
    };
    const pseudoTerm = vscode.window.createTerminal({ name: 'R Debugger', pty });
    return  pseudoTerm;
};


export function spawnChildProcess(directory: string) {
    const options = {
        cwd: directory
    }
    const cmdTerminal = getTerminalPath()
    const cmdArgs: string[] = [];
    // const cmdTerminal = getRpath()
    // const cmdArgs = ['--no-save', '--quiet', '--interactive']
    const cp = child.spawn(cmdTerminal, cmdArgs, options)
    // const Rpath = '"C:\\Program Files\\R\\R-3.6.1\\bin\\R.exe"';
    // const cp = child.spawn(Rpath, ['--no-save', '--interactive'], options)
    console.log("Spawned Process with PID: " + cp.pid)
    // const cp = child.spawn("cmd", ['/K', 'Rterminal', '--no-save']);

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