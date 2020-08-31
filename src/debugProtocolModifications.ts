

import { DebugProtocol } from 'vscode-debugprotocol';
import * as VsCode from 'vscode';

export enum DebugMode {
    Function = "function",
    File = "file",
    Workspace = "workspace"
}


export type DataSource = "stdout"|"stderr"|"jsonSocket"|"sinkSocket";
export type OutputMode = "all"|"filtered"|"nothing";

export interface RStartupArguments {
    path: string;
    args: string[];
    useJsonServer?: boolean;
    useSinkServer?: boolean;
    jsonPort?: number;
    sinkPort?: number;
    cwd?: string;
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
    append?: string;
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
}

export interface InitializeRequest extends DebugProtocol.InitializeRequest {
    arguments: InitializeRequestArguments;
}

export interface ContinueArguments extends DebugProtocol.ContinueArguments {
    callDebugSource?: boolean;
    source?: DebugProtocol.Source;
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

export interface CustomEvent extends DebugProtocol.Event {
    event: "custom";
    body: {
        reason: string;
    }
}

export interface ContinueOnBrowserPromptEvent extends CustomEvent {
    body: {
        reason: "continueOnBrowserPrompt";
        value: boolean;
        message?: string;
        repeatMessage?: boolean;
    }
}
