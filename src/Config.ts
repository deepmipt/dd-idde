import { readFileSync } from "fs";
import { autorun, computed, observable } from "mobx";
import {
	ColorTheme,
	ColorThemeKind,
	commands,
	ConfigurationTarget,
	env,
	Memento,
	Uri,
	window,
	workspace,
} from "vscode";
import { ColorScheme, DrawioLibraryData } from "./DrawioClient";
import { mapObject } from "./utils/mapObject";
import { SimpleTemplate } from "./utils/SimpleTemplate";
import {
	serializerWithDefault,
	VsCodeSetting,
} from "./vscode-utils/VsCodeSetting";

const extensionId = "hediet.vscode-drawio";
const experimentalFeaturesEnabled = "vscode-drawio.experimentalFeaturesEnabled";

export async function setContext(
	key: string,
	value: string | boolean
): Promise<void> {
	return (await commands.executeCommand("setContext", key, value)) as any;
}

export class Config {
	public readonly packageJson: {
		version: string;
		versionName: string | undefined;
		name: string;
		feedbackUrl?: string;
	} = JSON.parse(
		readFileSync
			? readFileSync(this.packageJsonPath, { encoding: "utf-8" })
			: "{}"
	);

	public get feedbackUrl(): Uri | undefined {
		if (this.packageJson.feedbackUrl) {
			return Uri.parse(this.packageJson.feedbackUrl);
		}
		return undefined;
	}

	public get isInsiders() {
		return (
			this.packageJson.name === "vscode-drawio-insiders-build" ||
			process.env.DEV === "1"
		);
	}

	@observable.ref
	private _vscodeTheme: ColorTheme;

	public get vscodeTheme(): ColorTheme {
		return this._vscodeTheme;
	}

	constructor(
		private readonly packageJsonPath: string,
		private readonly globalState: Memento
	) {
		autorun(() => {
			setContext(
				experimentalFeaturesEnabled,
				this.experimentalFeaturesEnabled
			);
		});

		this._vscodeTheme = window.activeColorTheme;
		window.onDidChangeActiveColorTheme((theme) => {
			this._vscodeTheme = theme;
		});
	}

	public getDiagramConfig(uri: Uri): DiagramConfig {
		return new DiagramConfig(uri, this);
	}

	private readonly _experimentalFeatures = new VsCodeSetting(
		`${extensionId}.enableExperimentalFeatures`,
		{
			serializer: serializerWithDefault<boolean>(false),
		}
	);

	public get experimentalFeaturesEnabled(): boolean {
		return this._experimentalFeatures.get();
	}

	public get canAskForFeedback(): boolean {
		if (
			this.getInternalConfig().versionLastAskedForFeedback ===
			this.packageJson.version
		) {
			return false;
		}
		const secondsIn20Minutes = 60 * 20;
		if (
			this.getInternalConfig().thisVersionUsageTimeInSeconds <
			secondsIn20Minutes
		) {
			return false;
		}
		return true;
	}

	public async markAskedToTest(): Promise<void> {
		await this.updateInternalConfig((config) => ({
			...config,
			versionLastAskedForFeedback: this.packageJson.version,
		}));
	}

	private readonly _knownPlugins = new VsCodeSetting<
		{ pluginId: string; fingerprint: string; allowed: boolean }[]
	>(`${extensionId}.knownPlugins`, {
		serializer: serializerWithDefault<any>([]),
		// Don't use workspace settings here!
		target: ConfigurationTarget.Global,
	});

	public isPluginAllowed(
		pluginId: string,
		fingerprint: string
	): boolean | undefined {
		const data = this._knownPlugins.get();
		const entry = data.find(
			(d) => d.pluginId === pluginId && d.fingerprint === fingerprint
		);
		if (!entry) {
			return undefined;
		}
		return entry.allowed;
	}

	public async addKnownPlugin(
		pluginId: string,
		fingerprint: string,
		allowed: boolean
	): Promise<void> {
		const plugins = [...this._knownPlugins.get()].filter(
			(p) => p.pluginId !== pluginId || p.fingerprint !== fingerprint
		);

		plugins.push({ pluginId, fingerprint, allowed });
		await this._knownPlugins.set(plugins);
	}

	public getUsageTimeInSeconds(): number {
		return this.getInternalConfig().totalUsageTimeInSeconds;
	}

	public getUsageTimeOfThisVersionInSeconds(): number {
		return this.getInternalConfig().thisVersionUsageTimeInSeconds;
	}

	public addUsageTime10Seconds(): void {
		this.updateInternalConfig((config) => {
			if (config.currentVersion !== this.packageJson.version) {
				config.currentVersion = this.packageJson.version;
				config.thisVersionUsageTimeInSeconds = 0;
			}

			return {
				...config,
				totalUsageTimeInSeconds: config.totalUsageTimeInSeconds + 10,
				thisVersionUsageTimeInSeconds:
					config.thisVersionUsageTimeInSeconds + 10,
			};
		});
	}

	public markAskedForSponsorship(): void {
		this.updateInternalConfig((c) => ({
			...c,
			dateTimeLastAskedForSponsorship: new Date().toDateString(),
			totalUsageTimeLastAskedForSponsorshipInSeconds:
				c.totalUsageTimeInSeconds,
		}));
	}

	public get canAskForSponsorship(): boolean {
		const c = this.getInternalConfig();
		if (c.dateTimeLastAskedForSponsorship) {
			const d = new Date(c.dateTimeLastAskedForSponsorship);
			const msOf60Days = 1000 * 60 * 60 * 24 * 60;
			if (new Date().getTime() - d.getTime() < msOf60Days) {
				return false;
			}
		}
		let usageTimeSinceLastAskedForSponsorship = c.totalUsageTimeInSeconds;
		if (c.totalUsageTimeLastAskedForSponsorshipInSeconds !== undefined) {
			usageTimeSinceLastAskedForSponsorship -=
				c.totalUsageTimeLastAskedForSponsorshipInSeconds;
		}
		const secondsIn1Hr = 60 * 60;
		if (usageTimeSinceLastAskedForSponsorship < secondsIn1Hr) {
			return false;
		}

		return true;
	}

	private getInternalConfig(): InternalConfig {
		return (
			this.globalState.get<InternalConfig>("config") || {
				totalUsageTimeInSeconds: 0,
				thisVersionUsageTimeInSeconds: 0,
				versionLastAskedForFeedback: undefined,
				dateTimeLastAskedForSponsorship: undefined,
				currentVersion: this.packageJson.version,
				totalUsageTimeLastAskedForSponsorshipInSeconds: 0,
			}
		);
	}

	private async setInternalConfig(config: InternalConfig): Promise<void> {
		await this.globalState.update("config", config);
	}

	private async updateInternalConfig(
		update: (oldConfig: InternalConfig) => InternalConfig
	): Promise<void> {
		const config = this.getInternalConfig();
		const updated = update(config);
		await this.setInternalConfig(updated);
	}
}

interface InternalConfig {
	totalUsageTimeInSeconds: number;
	thisVersionUsageTimeInSeconds: number;
	currentVersion: string;
	versionLastAskedForFeedback: string | undefined;
	dateTimeLastAskedForSponsorship: string | undefined;
	totalUsageTimeLastAskedForSponsorshipInSeconds: number | undefined;
}

export class DiagramConfig {
	//#region Custom Color Schemes

	private readonly _customColorSchemes = new VsCodeSetting(
		`${extensionId}.customColorSchemes`,
		{
			scope: this.uri,
			serializer: serializerWithDefault<ColorScheme[][]>([]),
		}
	);

	@computed
	public get customColorSchemes(): ColorScheme[][] {
		return this._customColorSchemes.get();
	}

	//#endregion

	//#region Preset Colors

	private readonly _presetColors = new VsCodeSetting(
		`${extensionId}.presetColors`,
		{
			scope: this.uri,
			serializer: serializerWithDefault<string[]>([]),
		}
	);

	@computed
	public get presetColors(): string[] {
		return this._presetColors.get();
	}

	//#endregion

	// #region Theme

	private readonly _theme = new VsCodeSetting(`${extensionId}.theme`, {
		scope: this.uri,
		serializer: serializerWithDefault("automatic"),
	});

	@computed
	public get theme(): string {
		const theme = this._theme.get();

		if (theme !== "automatic") {
			return theme;
		}

		return {
			[ColorThemeKind.Light]: "Kennedy",
			[ColorThemeKind.Dark]: "dark",
			[ColorThemeKind.HighContrast]: "Kennedy",
		}[this.config.vscodeTheme.kind];
	}

	public async setTheme(value: string): Promise<void> {
		await this._theme.set(value);
	}

	// #endregion

	// #region Mode

	private readonly _useOfflineMode = new VsCodeSetting(
		`${extensionId}.offline`,
		{
			scope: this.uri,
			serializer: serializerWithDefault(true),
		}
	);

	private readonly _onlineUrl = new VsCodeSetting(
		`${extensionId}.online-url`,
		{
			scope: this.uri,
			serializer: serializerWithDefault("https://embed.diagrams.net/"),
		}
	);

	public readonly _selectedPredictor = new VsCodeSetting(
		`dff.vscode-drawio.selected-predictor`,
		{
			scope: this.uri,
			serializer: serializerWithDefault("midas"),
		}
	);

	public readonly _sfcUrl = new VsCodeSetting(
		`dff.vscode-drawio.sfc-predictor-url`,
		{
			scope: this.uri,
			serializer: serializerWithDefault("https://7068.lnsigo.mipt.ru/annotation"),
		}
	);

	public readonly _midasUrl = new VsCodeSetting(
		`dff.vscode-drawio.midas-predictor-url`,
		{
			scope: this.uri,
			serializer: serializerWithDefault("http://localhost:8121/respond"),
		}
	);

	@computed
	public get mode(): { kind: "offline" } | { kind: "online"; url: string } {
		if (this._useOfflineMode.get()) {
			return { kind: "offline" };
		} else {
			return { kind: "online", url: this._onlineUrl.get() };
		}
	}

	// #endregion

	// #region Code Link Activated

	private readonly _codeLinkActivated = new VsCodeSetting(
		`${extensionId}.codeLinkActivated`,
		{
			scope: this.uri,
			serializer: serializerWithDefault(false),
		}
	);

	public get codeLinkActivated(): boolean {
		return this._codeLinkActivated.get();
	}

	public setCodeLinkActivated(value: boolean): Promise<void> {
		return this._codeLinkActivated.set(value);
	}

	// #endregion

	// #region Local Storage

	private readonly _localStorage = new VsCodeSetting<Record<string, string>>(
		`${extensionId}.local-storage`,
		{
			scope: this.uri,
			serializer: {
				deserialize: (value) => {
					if (typeof value === "object") {
						// stringify setting
						// https://github.com/microsoft/vscode/issues/98001
						mapObject(value, (item) =>
							typeof item === "string"
								? item
								: JSON.stringify(item)
						);
						return mapObject(value, (item) =>
							typeof item === "string"
								? item
								: JSON.stringify(item)
						);
					} else {
						const str = new Buffer(value || "", "base64").toString(
							"utf-8"
						);
						return JSON.parse(str);
					}
				},
				serializer: (val) => {
					function tryJsonParse(val: string): string | any {
						try {
							return JSON.parse(val);
						} catch (e) {
							return val;
						}
					}

					if (process.env.DEV === "1") {
						// jsonify obj
						const val2 = mapObject(val, (item) =>
							tryJsonParse(item)
						);
						return val2;
					}

					return Buffer.from(JSON.stringify(val), "utf-8").toString(
						"base64"
					);
				},
			},
		}
	);

	public get localStorage(): Record<string, string> {
		return this._localStorage.get();
	}

	public setLocalStorage(value: Record<string, string>): void {
		this._localStorage.set(value);
	}

	//#endregion

	private readonly _plugins = new VsCodeSetting<{ file: string }[]>(
		`${extensionId}.plugins`,
		{
			scope: this.uri,
			serializer: serializerWithDefault<any[]>([]),
		}
	);

	public get plugins(): { file: string }[] {
		return this._plugins.get().map((entry) => {
			const fullFilePath = this.evaluateTemplate(entry.file, "plugins");
			return { file: fullFilePath };
		});
	}

	// #region Custom Libraries

	private readonly _customLibraries = new VsCodeSetting<
		DrawioCustomLibrary[]
	>(`${extensionId}.customLibraries`, {
		scope: this.uri,
		serializer: serializerWithDefault<DrawioCustomLibrary[]>([]),
	});

	@computed
	public get customLibraries(): Promise<DrawioLibraryData[]> {
		const normalizeLib = async (
			lib: DrawioCustomLibrary
		): Promise<DrawioLibraryData> => {
			function parseJson(json: string): unknown {
				return JSON.parse(json);
			}

			function parseXml(xml: string): unknown {
				const parse = require("xml-parser-xo");
				const parsedXml = parse(xml);
				return JSON.parse(parsedXml.root.children[0].content);
			}

			let data: DrawioLibraryData["data"];
			if ("json" in lib) {
				data = { kind: "value", value: parseJson(lib.json) };
			} else if ("xml" in lib) {
				data = {
					kind: "value",
					value: parseXml(lib.xml),
				};
			} else if ("file" in lib) {
				const file = this.evaluateTemplate(
					lib.file,
					"custom libraries"
				);
				const buffer = await workspace.fs.readFile(Uri.file(file));
				const content = Buffer.from(buffer).toString("utf-8");
				if (file.endsWith(".json")) {
					data = {
						kind: "value",
						value: parseJson(content),
					};
				} else {
					data = {
						kind: "value",
						value: parseXml(content),
					};
				}
			} else {
				data = { kind: "url", url: lib.url };
			}

			return {
				libName: lib.libName,
				entryId: lib.entryId,
				data,
			};
		};

		return Promise.all(
			this._customLibraries.get().map((lib) => normalizeLib(lib))
		);
	}

	private evaluateTemplate(template: string, context: string): string {
		const tpl = new SimpleTemplate(template);
		return tpl.render({
			workspaceFolder: () => {
				const workspaceFolder = workspace.getWorkspaceFolder(this.uri);
				if (!workspaceFolder) {
					throw new Error(
						`Cannot get workspace folder of opened diagram - '${template}' cannot be evaluated to load ${context}!`
					);
				}
				return workspaceFolder.uri.fsPath;
			},
		});
	}

	// #endregion

	// #region Custom Fonts

	private readonly _customFonts = new VsCodeSetting<string[]>(
		`${extensionId}.customFonts`,
		{
			scope: this.uri,
			serializer: serializerWithDefault<string[]>([]),
		}
	);

	@computed
	public get customFonts(): string[] {
		return this._customFonts.get();
	}

	// #endregion

	constructor(public readonly uri: Uri, private readonly config: Config) { }

	@computed
	public get drawioLanguage(): string {
		if (env.language.toLowerCase() === "zh-tw") {
			// See https://github.com/hediet/vscode-drawio/issues/231.
			// Seems to be an exception, all other language codes are just the language, not the country.
			return "zh-tw";
		}
		const lang = env.language.split("-")[0].toLowerCase();
		return lang;
	}
}

type DrawioCustomLibrary = (
	| {
		xml: string;
	}
	| {
		url: string;
	}
	| {
		json: string;
	}
	| {
		file: string;
	}
) & { libName: string; entryId: string };
