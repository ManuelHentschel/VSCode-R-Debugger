
import { ShowDataViewerArguments } from './debugProtocolModifications';

import * as vscode from 'vscode';

// Argument provided by vscode when a command is called
// via the context menu of a variable in the debug panel
export interface DebugWindowCommandArg {
    container: {
        variablesReference: number;
    };
    variable: {
        name: string;
    }
}

// Sends a custom request to R to show a variable in the data viewer
export function showDataViewer(arg: DebugWindowCommandArg){
    const args: ShowDataViewerArguments = {
        reason: 'showDataViewer',
        variablesReference: arg.container.variablesReference,
        name: arg.variable.name
    };
    vscode.debug.activeDebugSession?.customRequest(
        "custom",
        args
    );
}

