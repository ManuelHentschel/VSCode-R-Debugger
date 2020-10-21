
import { getRDownloadLink, getRStartupArguments, config, getRequiredRPackageVersion } from './utils';
import * as vscode from 'vscode';
import { RSession } from './rSession';
import { write } from 'fs';

import Subject = require('await-notify');
import semver = require('semver');

export interface PackageVersionInfo {
	versionOk: boolean;
    shortMessage: string;
    longMessage?: string;
	version?: string;
};

export type VersionCheckLevel = "none"|"required"|"recommended";


export async function updateRPackage(packageName:string = 'vscDebugger') {
    vscode.window.showInformationMessage('Installing R Packages...');
    const url = getRDownloadLink(packageName);
    const rPath = (await getRStartupArguments()).path;
    const terminal = vscode.window.createTerminal('InstallRPackage');
    terminal.show();
    terminal.sendText(
        rPath +
        " --vanilla" +
        " --silent" +
        " -e \"install.packages('" + url + "', repos=NULL)\"" +
        " -e \"install.packages('jsonlite', repos='http://cran.r-project.org')\"" +
        " -e \"install.packages('R6', repos='http://cran.r-project.org')\""
    );
}

export function explainRPackage(writeOutput: (text: string)=>void, message: string = ""){
    message = message + (
        "\n\nIt can be attempted to install this package and the dependencies (currently R6 and jsonlite) automatically."
        + "\n\nTo do so, run the following command in the command palette (ctrl+shift+p):"
        + "\n\n\n\t\t" + "rdebugger.updateRPackage" + "\n"
        + "\n\nThis feature is still somewhat experimental!"
        + "\n\nIf this does not work or you want to make sure you have the latest version, follow the instructions in the readme to install the package yourself."
        + "\n\n\n"
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

    var versionOk: boolean = true;
    var shortMessage: string="";
    var longMessage: string="";

    if(checkLevel==="none"){
        versionOk = true;
    } else if(semver.gt(requiredVersion, version)){
        versionOk = false;
        shortMessage = "Please update the R Package!\n(See Debug Console for details)";
        longMessage = (
            "This version of the VSCode extension requires at least version " +
            requiredVersion +
            " of the R Package " +
            packageName +
            "!\n\nCurrently installed: " +
            version +
            "\n\nTo disable this warning, set the option \"rdebugger.checkVersion\"=\"none\".\n"
        );
    } else if(semver.gt(recommendedVersion, version) && checkLevel==="recommended"){
        versionOk = false;
        shortMessage = "Please update the R Package!\n(See Debug Console for details)";
        longMessage = (
            "With this version of the VSCode extension it is recommended to use at least version " +
            recommendedVersion +
            " of the R Package " +
            packageName +
            "!\n\nCurrently installed: " +
            version +
            "\n\nTo disable this warning, set the option \"rdebugger.checkVersion\"=\"none\" or \"rdebugger.checkVersion\"=\"required\".\n"
        );
    }

    return {
        versionOk: versionOk,
        shortMessage: shortMessage,
        longMessage: longMessage
    };
}
