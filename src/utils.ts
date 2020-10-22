
import { DebugProtocolMessage, window, workspace } from "vscode";
import { platform } from "os";
import { RStartupArguments } from './debugProtocolModifications';
import * as net from 'net';

import path = require("path");
import fs = require("fs");
import winreg = require("winreg");

const packageJson = require('../package.json');

export function config() {
    return workspace.getConfiguration("rdebugger");
}

function getRfromEnvPath(platform: string) {
    let splitChar: string = ":";
    let fileExtension: string = "";

    if (platform === "win32") {
        splitChar = ";";
        fileExtension = ".exe";
    }

    const os_paths: string[] | string = process.env.PATH.split(splitChar);
    for (const os_path of os_paths) {
        const os_r_path: string = path.join(os_path, "R" + fileExtension);
        if (fs.existsSync(os_r_path)) {
            return os_r_path;
        }
    }
    return "";
}


export function getPortNumber(server: net.Server){
    const address = server.address();
    if (typeof address === 'string' || address === undefined) {
        return -1;
    } else {
        return address.port;
    }
}


export function timeout(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


export async function getRStartupArguments(): Promise<RStartupArguments> {
    let rpath: string = "";
    const platform: string = process.platform;
    let rArgs: string[];

    if (platform === "win32") {
        rpath = config().get<string>("rterm.windows", "");
        if (rpath === "") {
            // Find path from registry
            try {
                const key = new winreg({
                    hive: winreg.HKLM,
                    key: "\\Software\\R-Core\\R",
                });
                const item: winreg.RegistryItem = await new Promise((c, e) =>
                    key.get("InstallPath", (err, result) => err === null ? c(result) : e(err)));
                rpath = path.join(item.value, "bin", "R.exe");
                rpath = '"' + rpath + '"';
            } catch (e) {
                rpath = "";
            }
        }
        rArgs = ['--ess', '--quiet', '--no-save'];
    } else if (platform === "darwin") {
        rpath = config().get<string>("rterm.mac", "");
        rArgs = ['--quiet', '--interactive', '--no-save'];
    } else if (platform === "linux") {
        rpath = config().get<string>("rterm.linux", "");
        rArgs = ['--quiet', '--interactive', '--no-save'];
    }

    if (rpath === "") {
        rpath = getRfromEnvPath(platform);
    }

    // enclose path in quotes if it contains spaces (and isn't quoted yet)
    if(rpath.match(/^[^"'].* .*[^"']$/)){
        rpath = `"${rpath}"`;
    }
    // replace single quotes with double quotes on windows
    if(platform === "win32" && rpath.match(/^'.* .*'$/)){
        rpath = rpath.replace(/^'(.*)'$/, '"$1"');
    }

    // add user specified args
    const customArgs = config().get<Array<string>>("rterm.args", []);
    rArgs = rArgs.concat(customArgs);

    const ret: RStartupArguments = {
        path: rpath,
        args: rArgs,
        cwd: undefined
    };

    if(rpath === ""){
        window.showErrorMessage(`${process.platform} can't find R`);
    }
    return ret;
}


export function getRDownloadLink(packageName: string): string{
    let url: string = config().get<string>("packageURL", "");

    if(url === ""){
        const platform: string = process.platform;
        const version: string = packageJson.version; // e.g. "0.1.2"
        const urlBase = 
            "https://github.com/ManuelHentschel/VSCode-R-Debugger/releases/download/v" +
            version +
            "/" +
            packageName +
            "_" +
            version;

        if(platform === "win32"){
            url = urlBase + ".zip";
        } else if(platform === "darwin"){
            url = urlBase + ".tgz";
        } else{
            url = urlBase + ".tar.gz";
        }
    }
    return url;
}

export function getVSCodePackageVersion(): string {
    return packageJson.version;
}

export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function getRequiredRPackageVersion(): {
    name?: string,
    required?: string,
    recommended?: string,
    warnIfNewer?: string
}{
    if(packageJson.rPackageInfo){
        return packageJson.rPackageInfo;
    } else{
        return {};
    }
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


