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
	console.log('port = ' + port);

	// register a configuration provider for 'R' debug type
	const provider = new DebugConfigurationProvider(port);
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', provider));

    // run the debug adapter inside the extension and directly talk to it
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
	// dummy?
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

		// todo: sensible defaults, if no file/folder is open

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'r') {
				let wd: string = '${fileDirname}';
				if(folder){
					wd = '{$workspaceFolder}';
				}
				strictConfig = {
					type: 'R-Debugger',
					name: 'Launch',
					request: 'launch',
					debugMode: DebugMode[DebugMode.File],
					file: '${file}',
					workingDirectory: wd,
					allowGlobalDebugging: true
				};
			}
		}

		const debugMode = config.debugMode;
		
		if(!config.workingDirectory){
			config.workingDirectory = '${workspaceFolder}';
		}
		if(debugMode === DebugMode.File || debugMode === DebugMode.Function){
			config.file = config.file || '${file}';
		}
		if(!config.mainFunction){
			config.mainFunction = 'main';
		}

		if(config.debugMode === DebugMode.Function){
			// make sure that all required fields (workingDirectory, file, function) are filled above!
			strictConfig = <FunctionDebugConfiguration>config;
		} else if(config.debugMode === DebugMode.File){
			// make sure that all required fields (workingDirectory, file) are filled above!
			strictConfig = <FileDebugConfiguration>config;
		} else if(config.debugMode === DebugMode.Workspace){
			// make sure that all required fields (workingDirectory) are filled above!
			strictConfig = <WorkspaceDebugConfiguration>config;
		} else if(config.request === 'attach'){
			config.customPort = this.customPort;
			config.customHost = this.customHost;
			config.useCustomSocket = true;
			strictConfig = <AttachConfiguration>config;
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
			const ret = new vscode.DebugAdapterServer(port, host);
			return ret;
		} else{
			throw new Error('Invalid entry "request" in debug config. Valid entries are "launch" and "attach"');
		}
	}
}

