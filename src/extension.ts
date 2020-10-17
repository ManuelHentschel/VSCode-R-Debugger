// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkspaceFolder, ProviderResult, CancellationToken } from 'vscode';
import { DebugSession } from './debugSession';
import {
	DebugConfiguration, DebugMode, FunctionDebugConfiguration,
	FileDebugConfiguration, WorkspaceDebugConfiguration,
	StrictDebugConfiguration,
	AttachConfiguration
} from './debugProtocolModifications';
import { updateRPackage } from './installRPackage';
import { trackTerminals, TerminalHandler } from './terminals';

let terminalHandler: TerminalHandler;

// this method is called when the extension is activated
export async function activate(context: vscode.ExtensionContext) {

	terminalHandler = new TerminalHandler();
	const port = await terminalHandler.portPromise;

	// register a configuration provider
	const provider = new DebugConfigurationProvider(port);
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', provider));

	// register the debug adapter descriptor provider
    const factory = new DebugAdapterDescriptorFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('R-Debugger', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}

	if(vscode.workspace.getConfiguration('rdebugger').get<boolean>('trackTerminals', false)){
		trackTerminals();
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('rdebugger.updateRPackage', updateRPackage)
	);
}

// this method is called when the extension is deactivated
export function deactivate() {
	// close connections opened by terminalHandler
	if(terminalHandler){
		terminalHandler.close();
	}
}


class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	readonly customPort: number;
	readonly customHost: string;

	constructor(customPort: number, customHost: string = 'localhost') {
		this.customPort = customPort;
		this.customHost = customHost;
	}

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: CancellationToken): ProviderResult<StrictDebugConfiguration> {

		let strictConfig: StrictDebugConfiguration|null = null;

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const doc = vscode.window.activeTextEditor;
			const wd = (folder ? '{$workspaceFolder}' : (doc ? '${fileDirname}' : '~'));
			if(doc){
				// if file is open, debug file
				config = {
					type: "R-Debugger",
					name: "Launch R Debugger",
					request: "launch",
					debugMode: "file",
					file: "${file}",
					workingDirectory: wd
				};
			} else if(wd){
				// if folder but no file is open, launch workspace
				config = {
					type: "R-Debugger",
					name: "Launch R Debugger",
					request: "launch",
					debugMode: "file",
					workingDirectory: wd
				};
			} else{
				// if no file/folder open, attach
				config = {
					type: 'R-Debugger',
					name: 'Launch',
					request: 'attach'
				};
			}
		}

		// fill custom capabilities/socket info
		if(config.request === 'launch'){
			// capabilities that are always true for this extension:
			config.supportsStdoutReading = true;
			config.supportsWriteToStdinEvent = true;
			config.supportsShowingPromptRequest = true;
		} else if (config.request === 'attach'){
			// communication info with TerminalHandler():
			config.customPort = config.customPort ?? this.customPort;
			config.customHost = config.customHost || this.customHost;
			config.useCustomSocket = config.useCustomSocket ?? true;
			config.supportsWriteToStdinEvent = config.supportsWriteToStdinEvent ?? true;
		}

		// make sure the config matches the requirements of one of the debug modes
		const debugMode: DebugMode|undefined = config.debugMode;
		if(config.request === 'attach'){
			// no fields mandatory
			strictConfig = <AttachConfiguration>config;
		} else if(debugMode === "function"){
			// make sure that all required fields (workingDirectory, file, function) are filled:
			config.workingDirectory = config.workingDirectory || '${workspaceFolder}';
			config.file = config.file || '${file}';
			config.mainFunction = config.mainFunction || 'main';
			strictConfig = <FunctionDebugConfiguration>config;
		} else if(debugMode === "file"){
			// make sure that all required fields (workingDirectory, file) are filled:
			config.workingDirectory = config.workingDirectory || '${workspaceFolder}';
			config.file = config.file || '${file}';
			strictConfig = <FileDebugConfiguration>config;
		} else if(debugMode === "workspace"){
			// make sure that all required fields (workingDirectory) are filled:
			config.workingDirectory = config.workingDirectory || '${workspaceFolder}';
			strictConfig = <WorkspaceDebugConfiguration>config;
		} else{
			strictConfig = null;
		}
		return strictConfig;
	}
}

class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		const config = session.configuration;
		if(config.request === 'launch'){
			return new vscode.DebugAdapterInlineImplementation(new DebugSession());
		} else if(config.request === 'attach'){
			const port: number = config.port || 18721;
			const host: string = config.host || 'localhost';
			return new vscode.DebugAdapterServer(port, host);
		} else{
			throw new Error('Invalid entry "request" in debug config. Valid entries are "launch" and "attach"');
		}
	}
}

