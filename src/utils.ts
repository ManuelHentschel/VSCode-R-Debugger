
import * as vscode from 'vscode';
import { platform } from 'os';
import { RStartupArguments } from './debugProtocolModifications';
import * as net from 'net';

import path = require('path');
import fs = require('fs');
import winreg = require('winreg');

export interface RPackageInfo {
    name: string,
    required: string,
    recommended: string,
    warnIfNewer: string
}

export interface PackageJson {
    [key: string]: any
    rPackageInfo: RPackageInfo
    version: string
}

const packageJson = <PackageJson>(require('../package.json'));

export function config(onlyDebugger: boolean = true): vscode.WorkspaceConfiguration {
    if(onlyDebugger){
        return vscode.workspace.getConfiguration('r.debugger');
    } else{
        return vscode.workspace.getConfiguration('r');
    }
}

function getRfromEnvPath(platform: string) {
    let splitChar: string = ':';
    let fileExtension: string = '';

    if (platform === 'win32') {
        splitChar = ';';
        fileExtension = '.exe';
    }

    const os_paths: string[] = process.env.PATH?.split(splitChar) || [];
    for (const os_path of os_paths) {
        const os_r_path: string = path.join(os_path, 'R' + fileExtension);
        if (fs.existsSync(os_r_path)) {
            return os_r_path;
        }
    }
    return '';
}

export async function getRpathFromSystem(): Promise<string> {
    
    let rpath = '';
    const platform: string = process.platform;
    
    rpath ||= getRfromEnvPath(platform);

    if ( !rpath && platform === 'win32') {
        // Find path from registry
        try {
            const key = new winreg({
                hive: winreg.HKLM,
                key: '\\Software\\R-Core\\R',
            });
            const item: winreg.RegistryItem = await new Promise((c, e) =>
                key.get('InstallPath', (err, result) => err === null ? c(result) : e(err)));
            rpath = path.join(item.value, 'bin', 'R.exe');
        } catch (e) {
            rpath = '';
        }
    }

    return rpath;
}

export async function getRpath(quote: boolean=false, overwriteConfig?: string): Promise<string> {
    let rpath: string | undefined = undefined;
    
    const configEntry = (
        process.platform === 'win32' ? 'rpath.windows' :
        process.platform === 'darwin' ? 'rpath.mac' :
        'rpath.linux'
    );

    // try the config entry specified in the function arg:
    if(overwriteConfig){
        rpath = config().get<string>(overwriteConfig);
    }

    // try the os-specific config entry for the rpath:
    rpath ||= config(false).get<string>(configEntry);

    // read from path/registry:
    rpath ||= await getRpathFromSystem();

    // represent all invalid paths (undefined, '', null) as '':
    rpath ||= '';

    if(!rpath){
        // inform user about missing R path:
        void vscode.window.showErrorMessage(`${process.platform} can't use R`);
    } else if(quote && /^[^'"].* .*[^'"]$/.exec(rpath)){
        // if requested and rpath contains spaces, add quotes:
        rpath = `"${rpath}"`;
    } else if(process.platform === 'win32' && /^'.* .*'$/.exec(rpath)){
        // replace single quotes with double quotes on windows
        rpath = rpath.replace(/^'(.*)'$/, '"$1"');
    }

    return rpath;
}

export function getPortNumber(server?: net.Server): number {
    const address = server?.address();
    if (typeof address === 'string' || !address) {
        return -1;
    } else {
        return address.port;
    }
}


export function timeout(ms: number): Promise<unknown> {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export async function getRStartupArguments(launchConfig: {
    env?: {[key: string]: string};
    commandLineArgs?: string[];
    launchDirectory?: string;
} = {}): Promise<RStartupArguments> {
    const platform: string = process.platform;

    const rpath = await getRpath(true);

    const rArgs: string[] = [
        '--quiet',
        '--no-save',
        (platform === 'win32' ? '--ess' : '--interactive')
    ];

    // add user specified args
    const customArgs = config().get<Array<string>>('commandLineArgs', []);
    rArgs.push(...customArgs);
    rArgs.push(...(launchConfig.commandLineArgs || []));

    const ret: RStartupArguments = {
        path: rpath,
        args: rArgs,
        cwd: launchConfig.launchDirectory,
        env: launchConfig.env
    };

    if(rpath === ''){
        void vscode.window.showErrorMessage(`${process.platform} can't find R`);
    }
    return ret;
}


export function getRDownloadLink(): string{
    let url: string = config().get<string>('packageURL', '');

    if(url === ''){
        const platform = process.platform;
        const extensionVersion = packageJson.version;
        const rPackageVersion = packageJson.rPackageInfo.recommended; // e.g. "0.1.2"
        const rPackageName = packageJson.rPackageInfo.name;
        const urlBase = 
            'https://github.com/ManuelHentschel/VSCode-R-Debugger/releases/download/v' +
            extensionVersion +
            '/' +
            rPackageName +
            '_' +
            rPackageVersion;

        if(platform === 'win32'){
            url = urlBase + '.zip';
        } else if(platform === 'darwin'){
            url = urlBase + '.tgz';
        } else{
            url = urlBase + '.tar.gz';
        }
    }
    return url;
}

export function getVSCodePackageVersion(): string {
    return String(packageJson.version);
}

export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function getRequiredRPackageVersion(): RPackageInfo {
    return packageJson.rPackageInfo;
}


export function escapeStringForR(s: string, quote: string='"'): string {
    if (s === undefined) {
        return 'NULL';
    } else {
        return(
            quote
            + s.replace(/\\/g, '\\\\')
                .replace(RegExp(quote, 'g'), `\\${quote}`)
                .replace(/\n/g, '\\n')
                // .replace(/\r/g, "\\r")
                .replace(/\r/g, '')
                .replace(/\t/g, '\\t')
                .replace(/\f/g, '\\f')
                .replace(/\v/g, '\\v')
            + quote);
    }
}


export async function checkSettings(): Promise<boolean> {
    const config0 = vscode.workspace.getConfiguration('rdebugger');

    const keys = Object.getOwnPropertyNames(config0);

    const deprecated = [
        'rterm',
        'timeouts',
        'checkVersion',
        'trackTerminals'
    ];

    const foundDeprecated = deprecated.filter((v) => checkDeprecated(config0, v));

    console.log(keys);
    console.log(foundDeprecated);

    if(foundDeprecated.length === 0){
        return false;
    }

    const ret1 = 'Open Settings';
    const ret2 = 'Don\'t show again';

    const ret = await vscode.window.showInformationMessage(
        `Configuration for R-Debugger has moved (affects: ${foundDeprecated.map(v => 'rdebugger.' + v).join(', ')}). Open settings?`,
        ret1,
        ret2
    );

    if(ret === ret1){
        void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rdebugger.r-debugger');
    }

    return ret === ret2;
}

function checkDeprecated(config: vscode.WorkspaceConfiguration, entry: string): boolean {
    const info = config.inspect(entry);

    const changed: boolean = !!(info && (
        info.globalLanguageValue ||
        info.globalValue ||
        info.workspaceFolderLanguageValue ||
        info.workspaceFolderValue ||
        info.workspaceLanguageValue ||
        info.workspaceValue
    ));

    return changed;
}
