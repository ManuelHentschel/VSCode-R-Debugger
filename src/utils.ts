
import { window, workspace } from "vscode";
// let config = workspace.getConfiguration();
const config = workspace.getConfiguration('rdebugger');


export function getRPath() {
    if (process.platform === "win32") {
        return config.get<string>("rterm.windows", "R");
    }
    if (process.platform === "darwin") {
        return config.get<string>("rterm.mac", "");
    }
    if (process.platform === "linux") {
        return config.get<string>("rterm.linux", "");
    }
    window.showErrorMessage(`${process.platform} can't find R`);
    return "";
}

export function getTerminalPath() {
    if (process.platform === "win32") {
        return config.get<string>("terminal.windows", "");
    }
    if (process.platform === "darwin") {
        return config.get<string>("terminal.mac", "");
    }
    if (process.platform === "linux") {
        return config.get<string>("terminal.linux", "");
    }
    window.showErrorMessage(`${process.platform} can't find Terminal`);
    return "";
}


export function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

