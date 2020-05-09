
import * as child from 'child_process';
import * as vscode from 'vscode';
import { getRPath, getTerminalPath } from './utils';

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

