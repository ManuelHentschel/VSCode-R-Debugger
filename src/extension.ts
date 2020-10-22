
import * as vscode from 'vscode';
import { WorkspaceFolder, ProviderResult, CancellationToken, DebugConfigurationProviderTriggerKind } from 'vscode';
import { DebugAdapter } from './debugAdapter';
import {
	DebugMode, FunctionDebugConfiguration,
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

	// register configuration resolver
	const resolver = new DebugConfigurationResolver(port);
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', resolver));

	// register dynamic configuration provider
	const dynamicProvider = new DynamicDebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', dynamicProvider, DebugConfigurationProviderTriggerKind.Dynamic));

	// register initial configuration provider
	const initialProvider = new InitialDebugConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('R-Debugger', initialProvider, DebugConfigurationProviderTriggerKind.Initial));

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

class DebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		const config = session.configuration;
		if(config.request === 'launch'){
			return new vscode.DebugAdapterInlineImplementation(new DebugAdapter());
		} else if(config.request === 'attach'){
			const port: number = config.port || 18721;
			const host: string = config.host || 'localhost';
			return new vscode.DebugAdapterServer(port, host);
		} else{
			throw new Error('Invalid entry "request" in debug config. Valid entries are "launch" and "attach"');
		}
	}
}


class InitialDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<StrictDebugConfiguration[]>{
		return [
			{
				type: "R-Debugger",
				request: "launch",
				name: "Launch Workspace",
				debugMode: "workspace",
				workingDirectory: "${workspaceFolder}",
				allowGlobalDebugging: true
			},
			{
				type: "R-Debugger",
				request: "launch",
				name: "Debug R-File",
				debugMode: "file",
				workingDirectory: "${workspaceFolder}",
				file: "${file}",
				allowGlobalDebugging: true
			},
			{
				type: "R-Debugger",
				request: "launch",
				name: "Debug R-Function",
				debugMode: "function",
				workingDirectory: "${workspaceFolder}",
				file: "${file}",
				mainFunction: "main",
				allowGlobalDebugging: false
			},
			{
				type: "R-Debugger",
				request: "attach",
				name: "Attach to R process",
				splitOverwrittenOutput: true
			}
		];
	}
}

class DynamicDebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<StrictDebugConfiguration[]>{

		const doc = vscode.window.activeTextEditor;
		const docValid = doc && doc.document.uri.scheme === 'file';
		const wd = (folder ? '${workspaceFolder}' : (docValid ? '${fileDirname}' : '.'));

		let configs: StrictDebugConfiguration[] = [];

		configs.push({
            type: "R-Debugger",
            request: "launch",
            name: "Launch Workspace",
            debugMode: "workspace",
            workingDirectory: wd,
            allowGlobalDebugging: true
		});

		if(docValid){
			configs.push({
				type: "R-Debugger",
				request: "launch",
				name: "Debug R-File",
				debugMode: "file",
				workingDirectory: wd,
				file: "${file}",
				allowGlobalDebugging: true
			});

			configs.push({
				type: "R-Debugger",
				request: "launch",
				name: "Debug R-Function",
				debugMode: "function",
				workingDirectory: wd,
				file: "${file}",
				mainFunction: "main",
				allowGlobalDebugging: false
			});
		};

		configs.push({
            type: "R-Debugger",
            request: "attach",
            name: "Attach to R process",
            splitOverwrittenOutput: true
		});

		return configs;
	}
}

class DebugConfigurationResolver implements vscode.DebugConfigurationProvider {

	readonly customPort: number;
	readonly customHost: string;

	constructor(customPort: number, customHost: string = 'localhost') {
		this.customPort = customPort;
		this.customHost = customHost;
	}

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: CancellationToken): ProviderResult<StrictDebugConfiguration> {

		let strictConfig: StrictDebugConfiguration|null = null;

		// if the debugger was launched without config
		if (!config.type && !config.request && !config.name) {

			const doc = vscode.window.activeTextEditor;
			const docValid = doc && doc.document.uri.scheme === 'file';
			const wd = (folder ? '${workspaceFolder}' : (docValid ? '${fileDirname}' : '.'));
			if(docValid){
				// if file is open, debug file
				config = {
					type: "R-Debugger",
					name: "Launch R Debugger",
					request: "launch",
					debugMode: "file",
					file: "${file}",
					workingDirectory: wd
				};
			} else{
				// if folder but no file is open, launch workspace
				config = {
					type: "R-Debugger",
					name: "Launch R Debugger",
					request: "launch",
					debugMode: "workspace",
					workingDirectory: wd
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
