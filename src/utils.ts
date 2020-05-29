
import { window, workspace } from "vscode";
import path = require("path");
import fs = require("fs");
import winreg = require("winreg");

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

export async function getRPath() {
    let rpath: string = "";
    const platform: string = process.platform;

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
            } catch (e) {
                rpath = "";
            }
        }
    } else if (platform === "darwin") {
        rpath = config().get<string>("rterm.mac", "");
    } else if (platform === "linux") {
        rpath = config().get<string>("rterm.linux", "");
    }

    if (rpath === "") {
        rpath = getRfromEnvPath(platform);
    }
    if (rpath !== "") {
        return rpath;
    }
    window.showErrorMessage(`${process.platform} can't find R`);
    return "";
}

export function getTerminalPath() {
    if (process.platform === "win32") {
        return config().get<string>("terminal.windows", "");
    }
    if (process.platform === "darwin") {
        return config().get<string>("terminal.mac", "");
    }
    if (process.platform === "linux") {
        return config().get<string>("terminal.linux", "");
    }
    window.showErrorMessage(`${process.platform} can't find Terminal`);
    return "";
}


export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

