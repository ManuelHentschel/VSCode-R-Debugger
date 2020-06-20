

import { DebugProtocol } from 'vscode-debugprotocol';
import * as VsCode from 'vscode';

export enum DebugMode {
    Function = "function",
    File = "file",
    Workspace = "workspace"
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
