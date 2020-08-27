
import { getRDownloadLink } from './utils';
import * as vscode from 'vscode';
import { RSession } from './rSession';
import { write } from 'fs';
const { Subject } = require('await-notify');

export async function installRPackage(rSession: RSession, packageName: string, writeOutput: (text: string)=>void): Promise<boolean>{

    const message = (
        "\nThe debugger requires the R package 'vscDebugger' to run."
        + "\n\nIt can be attempted to install this package and the dependencies (currently R6 and jsonlite) automatically."
        + "\n\nThis feature is still somewhat experimental!"
        + "\n\nIf this does not work or you want to make sure you have the latest version, follow the instructions in the readme to install the package yourself."
        + "\n"
    );

    writeOutput(message);

    const ret = await vscode.window.showWarningMessage(
    // const ret = await vscode.window.showInformationMessage(
        "Do you want to install the required R packages?"
        + "\n(For details see debug console)",
        "Yes", "No"
    );

    if(ret!=="Yes"){
        return false;
    }

    const url = getRDownloadLink(packageName);

    rSession.defaultLibrary = '';

    rSession.callFunction('install.packages', url);
    rSession.callFunction('install.packages', 'jsonlite', {repos: 'http://cran.r-project.org'});
    rSession.callFunction('install.packages', 'R6', {repos: 'http://cran.r-project.org'});

    rSession.callFunction('quit');

    const rClosed = new Subject();

    rSession.cp.addListener('close', (code, signal) => {
        rClosed.notify();
    });

    await rClosed.wait(300*1000); //5min

    return true;
}




