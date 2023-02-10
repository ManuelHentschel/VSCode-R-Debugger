
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

export type VersionCheckLevel = 'none'|'required'|'recommended';

export function explainRPackage(writeOutput: (text: string)=>void, message: string = ''): void {
    message = message + (
        '\n\n Follow the instructions in the readme to install the package yourself.'
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
