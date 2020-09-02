

import { DebugProtocol } from 'vscode-debugprotocol';
import * as VsCode from 'vscode';

export enum DebugMode {
    Function = "function",
    File = "file",
    Workspace = "workspace"
}


export interface RStartupArguments {
    path: string;
    args: string[];
    useJsonServer?: boolean;
    useSinkServer?: boolean;
    jsonPort?: number;
    sinkPort?: number;
    cwd: string;
}


export interface DebugConfiguration extends VsCode.DebugConfiguration {
    // specify what to debug (required)
    debugMode: DebugMode;
    allowGlobalDebugging: boolean;

    // specify where to debug (some required, depends on debugMode)
    workingDirectory?: string;
    file?: string;
    mainFunction?: string;

    // specify how to debug (optional)
    includePackageScopes?: boolean;
    setBreakpointsInPackages?: boolean;
    packagesBeforeLaunch?: string[];
    assignToAns?: boolean;
    overwritePrint?: boolean;
    overwriteCat?: boolean;
    overwriteSource?: boolean;
}

export interface FunctionDebugConfiguration extends DebugConfiguration {
    debugMode: DebugMode.Function;
    workingDirectory: string;
    file: string;
    mainFunction: string;
}
export interface FileDebugConfiguration extends DebugConfiguration {
    debugMode: DebugMode.File;
    workingDirectory: string;
    file: string;
}
export interface WorkspaceDebugConfiguration extends DebugConfiguration {
    debugMode: DebugMode.Workspace;
    workingDirectory: string;
}

export type StrictDebugConfiguration = FunctionDebugConfiguration | FileDebugConfiguration | WorkspaceDebugConfiguration;

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, DebugConfiguration {
}

export interface RStrings {
    delimiter0?: string;
    delimiter1?: string;
    prompt?: string;
    continue?: string;
    startup?: string;
    libraryNotFound?: string;
    packageName?: string;
}

export interface InitializeRequestArguments extends DebugProtocol.InitializeRequestArguments {
    rStrings?: RStrings;
    threadId?: number;
    useJsonServer?: boolean;
    jsonPort?: number;
    jsonHost?: string;
    useSinkServer?: boolean;
    sinkPort?: number;
    sinkHost?: string;
    extensionVersion?: string;
}

export interface InitializeRequest extends DebugProtocol.InitializeRequest {
    arguments: InitializeRequestArguments;
}

export interface PackageInfo {
    Package: string;
    Version: string;
};

export interface InitializeResponse extends DebugProtocol.InitializeResponse {
    packageInfo?: PackageInfo;
}

export interface ContinueArguments extends DebugProtocol.ContinueArguments {
    callDebugSource?: boolean;
    source?: DebugProtocol.Source;
}

export interface ContinueRequest extends DebugProtocol.ContinueRequest {
    arguments: ContinueArguments;
}

export interface Source extends DebugProtocol.Source {
    srcbody?: string;
}

export interface SourceArguments extends DebugProtocol.SourceArguments {
    source?: Source;
}


export interface ResponseWithBody extends DebugProtocol.Response {
    body?: { [key: string]: any; };
}

// Used to send info to VS Code that is not part of the DAP
export interface CustomEvent extends DebugProtocol.Event {
    event: "custom";
    body: {
        reason: string;
    }
}

// Indicate that VS-Code should write a given text to R's stdin
export interface WriteToStdinEvent extends CustomEvent {
    body: WriteToStdinBody;
}
export interface WriteToStdinBody {
    reason: "writeToStdin";
    text: string;
    when?: "now"|"browserPrompt"|"topLevelPrompt"|"prompt";
    addNewLine?: boolean; //=false (in vscode), =true (in R)
    changeExpectBrowser?: boolean;
    expectBrowser?: boolean;
}

// Used to send info to R that is not part of the DAP
export interface CustomRequest extends DebugProtocol.Request {
    command: "custom"
    arguments: {
        reason: string;
    }
}

// Indicate that R is showing the input prompt in its stdout
export interface ShowingPromptRequest extends CustomRequest {
    arguments: {
        reason: "showingPrompt";
        which?: "browser"|"topLevel";
        text?: string;
    }
}


