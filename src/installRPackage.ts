
import { getRDownloadLink, getRStartupArguments, config, getRequiredRPackageVersion } from './utils';
import * as vscode from 'vscode';
import { join } from 'path';
import semver = require('semver');

export interface PackageVersionInfo {
    versionOk: boolean;
    shortMessage: string;
    longMessage?: string;
    version?: string;
}

type VersionCheckLevel = 'none'|'required'|'recommended';


export async function updateRPackage(extensionPath: string): Promise<void> {
    const url = getRDownloadLink();
    const rPath = (await getRStartupArguments()).path.replace(/^"(.*)"$/, '$1');
    const taskDefinition: vscode.TaskDefinition = {
        type: 'process'
    };
    const args = [
        '--no-restore',
        '--quiet',
        '-f',
        `${join(extensionPath, 'R', 'install.R')}`,
        '--args',
        `${url}`
    ];
    const processExecution = new vscode.ProcessExecution(rPath, args);
    const installationTask = new vscode.Task(
        taskDefinition,
        vscode.TaskScope.Global,
        'Install vscDebugger',
        'R-Debugger',
        processExecution
    );
    
    const taskExecutionRunning = await vscode.tasks.executeTask(installationTask);
    
    const taskDonePromise = new Promise<void>((resolve) => {
        vscode.tasks.onDidEndTask(e => {
            if (e.execution === taskExecutionRunning) {
                resolve();
            }
        });
    });
    
    return await taskDonePromise;
}

export function explainRPackage(writeOutput: (text: string)=>void, message: string = ''): void {
    message = message + (
        '\n\nIt can be attempted to install this package and the dependencies (currently R6 and jsonlite) automatically.'
        + '\n\nTo do so, run the following command in the command palette (ctrl+shift+p):'
        + '\n\n\n\t\t' + 'r.debugger.updateRPackage' + '\n'
        + '\n\nThis feature is still somewhat experimental!'
        + '\n\nIf this does not work or you want to make sure you have the latest version, follow the instructions in the readme to install the package yourself.'
        + '\n\n\n'
    );

    writeOutput(message);
}

export function checkPackageVersion(version: string): PackageVersionInfo {
    const checkLevel = config().get<VersionCheckLevel>('checkVersion', 'required');
    const rPackageVersions = getRequiredRPackageVersion();
    const requiredVersion = rPackageVersions.required || '0.0.0';
    const recommendedVersion = rPackageVersions.recommended || '0.0.0';
    const warnIfNewerVersion = rPackageVersions.warnIfNewer || '999.99.99';
    const packageName = rPackageVersions.name || 'vscDebugger';

    let versionOk: boolean = true;
    let shortMessage: string='';
    let longMessage: string='';

    if(checkLevel==='none'){
        versionOk = true;
    } else if(semver.gt(requiredVersion, version)){
        versionOk = false;
        shortMessage = 'Please update the R Package!\n(See Debug Console for details)';
        longMessage = (
            'This version of the VSCode extension requires at least version ' +
            requiredVersion +
            ' of the R Package ' +
            packageName +
            '!\n\nCurrently installed: ' +
            version +
            '\n\nTo disable this warning, set the option "r.debugger.checkVersion"="none".\n'
        );
    } else if(semver.gt(recommendedVersion, version) && checkLevel==='recommended'){
        versionOk = false;
        shortMessage = 'Please update the R Package!\n(See Debug Console for details)';
        longMessage = (
            'With this version of the VSCode extension it is recommended to use at least version ' +
            recommendedVersion +
            ' of the R Package ' +
            packageName +
            '!\n\nCurrently installed: ' +
            version +
            '\n\nTo disable this warning, set the option "r.debugger.checkVersion"="none" or "r.debugger.checkVersion"="required".\n'
        );
    }

    return {
        versionOk: versionOk,
        shortMessage: shortMessage,
        longMessage: longMessage
    };
}
