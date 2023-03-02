/* eslint-disable no-console */
import { AstroCheck, DiagnosticSeverity, GetDiagnosticsResult } from '@astrojs/language-server';
import type { AstroSettings } from '../../@types/astro';
import type { LogOptions } from '../../core/logger/core.js';
import glob from 'fast-glob';
import * as fs from 'fs';
import { bold, dim, red, yellow } from 'kleur/colors';
import { createRequire } from 'module';
import ora from 'ora';
import { fileURLToPath, pathToFileURL } from 'url';
import { printDiagnostic } from './print.js';
import type { Arguments as Flags } from 'yargs-parser';
import { debug, info } from '../../core/logger/core.js';
import { createServer, ViteDevServer } from 'vite';
import { createVite } from '../../core/create-vite.js';
import type { CreateViteOptions } from '../../core/create-vite';
import type { SyncOptions, ProcessExit } from '../../core/sync';
import fsMod from 'fs';

type DiagnosticResult = {
	errors: number;
	warnings: number;
	hints: number;
};

type CheckPayload = {
	/**
	 * Flags passed via CLI
	 */
	flags: Flags;

	/**
	 * Logging options
	 */
	logging: LogOptions;
};

type CheckFlags = {
	/**
	 * Whether the `check` command should watch for `.astro` and report errors
	 * @default {false}
	 */
	watch: boolean;
};

/**
 *
 * Types of response emitted by the checker
 */
export enum CheckResult {
	/**
	 * Operation finished without errors
	 */
	ExitWithSuccess,
	/**
	 * Operation finished with errors
	 */
	ExitWithError,
	/**
	 * The consumer should not terminate the operation
	 */
	Listen,
}

const ASTRO_GLOB_PATTERN = '**/*.astro';

/**
 * Checks `.astro` files for possible errors.
 *
 * If the `--check` flag is provided, the command runs indefinitely and provides diagnostics
 * when `.astro` files are modified.
 *
 * Every time an astro files is modified, content collections are also generated.
 *
 * @param {AstroSettings} settings
 * @param {CheckPayload} options
 * @param {Flags} options.flags
 * @param {LogOptions} options.logging
 */
export async function check(
	settings: AstroSettings,
	{ logging, flags }: CheckPayload
): Promise<CheckServer> {
	let checkFlags = parseFlags(flags);
	let options: CreateViteOptions = { settings, logging, mode: 'build', fs };
	if (checkFlags.watch) {
		info(logging, 'check', 'Checking files in watch mode');
		options.isWatcherEnabled = true;
	} else {
		info(logging, 'check', 'Checking files');
	}
	// We create a server to start doing our operations
	const viteServer = await createServer(
		await createVite(
			{
				server: { middlewareMode: true, hmr: false },
				optimizeDeps: { entries: [] },
				logLevel: 'silent',
			},
			options
		)
	);

	const { syncCli } = await import('../../core/sync/index.js');
	const root = settings.config.root;
	const require = createRequire(import.meta.url);
	let diagnosticChecker = new AstroCheck(
		root.toString(),
		require.resolve('typescript/lib/tsserverlibrary.js', { paths: [root.toString()] })
	);

	return new CheckServer({
		syncCli,
		settings,
		server: viteServer,
		fileSystem: fs,
		logging,
		diagnosticChecker,
		isWatchMode: checkFlags.watch,
	});
}

type CheckerConstructor = {
	server: ViteDevServer;
	diagnosticChecker: AstroCheck;

	isWatchMode: boolean;

	syncCli: (settings: AstroSettings, options: SyncOptions) => Promise<ProcessExit>;

	settings: Readonly<AstroSettings>;

	logging: Readonly<LogOptions>;

	fileSystem: typeof fsMod;
};

/**
 * Responsible to check files - classic or watch mode - and report diagnostics.
 *
 * When in watch mode, the class does a whole check pass, and then starts watching files.
 * When a change occurs to an `.astro` file, the checker builds content collections again and lint all the `.astro` files.
 */
class CheckServer {
	readonly #server: ViteDevServer;
	readonly #diagnosticsChecker: AstroCheck;
	readonly #shouldWatch: boolean;
	readonly #syncCli: (settings: AstroSettings, opts: SyncOptions) => Promise<ProcessExit>;

	readonly #settings: AstroSettings;

	readonly #logging: LogOptions;
	readonly #fs: typeof fsMod;

	#filesCount: number;
	#updateDiagnostics: NodeJS.Timeout | undefined;
	constructor({
		server,
		diagnosticChecker,
		isWatchMode,
		syncCli,
		settings,
		fileSystem,
		logging,
	}: CheckerConstructor) {
		this.#server = server;
		this.#diagnosticsChecker = diagnosticChecker;
		this.#shouldWatch = isWatchMode;
		this.#syncCli = syncCli;
		this.#logging = logging;
		this.#settings = settings;
		this.#fs = fileSystem;
		this.#filesCount = 0;
	}

	/**
	 * Check all `.astro` files once and then finishes the operation.
	 * @returns {Promise<CheckResult>}
	 */
	public async check(): Promise<CheckResult> {
		return await this.#checkAllFiles(true);
	}

	/**
	 * Check all `.astro` files and then start watching for changes.
	 * @returns {Promise<CheckResult.Listen>}
	 */
	public async watch(): Promise<CheckResult.Listen> {
		await this.#checkAllFiles(true);
		this.#watch();
		return CheckResult.Listen;
	}

	/**
	 * Stops the watch. It terminates the inner server.
	 */
	public async stop() {
		await this.#server.close();
	}

	/**
	 * Weather the checker should run in watch mode
	 * @returns {boolean}
	 */
	public get isWatchMode(): boolean {
		return this.#shouldWatch;
	}

	async #openDocuments() {
		this.#filesCount = await openAllDocuments(
			this.#settings.config.root,
			[],
			this.#diagnosticsChecker
		);
	}

	/**
	 * Lint all `.astro` files, and report the result in console. Operations executed, in order:
	 * 1. Compile content collections.
	 * 2. Optionally, traverse the file system for `.astro` files and saves their paths.
	 * 3. Get diagnostics for said files and print the result in console.
	 *
	 * @param {boolean} [openDocuments=false] Whether the operation should open all `.astro` files
	 * @private
	 */
	async #checkAllFiles(openDocuments = false): Promise<CheckResult> {
		const processExit = await this.#syncCli(this.#settings, {
			logging: this.#logging,
			fs: this.#fs,
		});
		// early exit on sync failure
		if (processExit === 1) return processExit;

		let spinner = ora(
			` Getting diagnostics for Astro files in ${fileURLToPath(this.#settings.config.root)}…`
		).start();

		if (openDocuments) {
			await this.#openDocuments();
		}

		let diagnostics = await this.#diagnosticsChecker.getDiagnostics();

		spinner.succeed();

		let brokenDownDiagnostics = this.#breakDownDiagnostics(diagnostics);
		this.#logDiagnosticsSeverity(brokenDownDiagnostics);
		return brokenDownDiagnostics.errors > 0
			? CheckResult.ExitWithError
			: CheckResult.ExitWithSuccess;
	}

	#checkForDiagnostics() {
		clearTimeout(this.#updateDiagnostics);
		// @ematipico: I am not sure of `setTimeout`. I would rather use a debounce but let's see if this works.
		// Inspiration from `svelte-check`.
		this.#updateDiagnostics = setTimeout(async () => await this.#checkAllFiles(false), 500);
	}

	/**
	 * This function is responsible to attach events to the server watcher
	 * @private
	 */
	#watch() {
		this.#server.watcher.on('add', (file) => {
			if (file.endsWith('.astro')) {
				this.#addDocument(file);
				this.#filesCount += 1;
				this.#checkForDiagnostics();
			}
		});
		this.#server.watcher.on('change', (file) => {
			if (file.endsWith('.astro')) {
				this.#addDocument(file);
				this.#checkForDiagnostics();
			}
		});
		this.#server.watcher.on('unlink', (file) => {
			if (file.endsWith('.astro')) {
				this.#diagnosticsChecker.removeDocument(file);
				this.#filesCount -= 1;
				this.#checkForDiagnostics();
			}
		});
	}

	/**
	 * Add a document to the diagnostics checker
	 * @param filePath
	 * @private
	 */
	#addDocument(filePath: string) {
		const text = fs.readFileSync(filePath, 'utf-8');
		this.#diagnosticsChecker.upsertDocument({
			uri: pathToFileURL(filePath).toString(),
			text,
		});
	}

	/**
	 * Logs the result of the various diagnostics
	 *
	 * @param {Readonly<DiagnosticResult>} result
	 */
	#logDiagnosticsSeverity(result: Readonly<DiagnosticResult>) {
		info(
			this.#logging,
			'diagnostics',
			[
				bold(`Result (${this.#filesCount} file${this.#filesCount === 1 ? '' : 's'}): `),
				bold(red(`${result.errors} ${result.errors === 1 ? 'error' : 'errors'}`)),
				bold(yellow(`${result.warnings} ${result.warnings === 1 ? 'warning' : 'warnings'}`)),
				dim(`${result.hints} ${result.hints === 1 ? 'hint' : 'hints'}\n`),
			].join(`\n${dim('-')} `)
		);
	}

	/**
	 * It loops through all diagnostics and break down diagnostics that are errors, warnings or hints.
	 * @param {Readonly<GetDiagnosticsResult[]>} diagnostics
	 */
	#breakDownDiagnostics(diagnostics: Readonly<GetDiagnosticsResult[]>): DiagnosticResult {
		let result: DiagnosticResult = {
			errors: 0,
			warnings: 0,
			hints: 0,
		};

		diagnostics.forEach((diag) => {
			diag.diagnostics.forEach((d) => {
				info(this.#logging, 'diagnostics', `\n ${printDiagnostic(diag.fileUri, diag.text, d)}`);

				switch (d.severity) {
					case DiagnosticSeverity.Error: {
						result.errors++;
						break;
					}
					case DiagnosticSeverity.Warning: {
						result.warnings++;
						break;
					}
					case DiagnosticSeverity.Hint: {
						result.hints++;
						break;
					}
				}
			});
		});

		return result;
	}
}

/**
 * Open all Astro files in the given directory and return the number of files found.*
 * @param {URL} workspaceUri
 * @param {string[]} filePathsToIgnore
 * @param {AstroCheck} checker
 */
async function openAllDocuments(
	workspaceUri: URL,
	filePathsToIgnore: string[],
	checker: AstroCheck
): Promise<number> {
	const files = await glob(ASTRO_GLOB_PATTERN, {
		cwd: fileURLToPath(workspaceUri),
		ignore: ['node_modules/**'].concat(filePathsToIgnore.map((ignore) => `${ignore}/**`)),
		absolute: true,
	});

	for (const file of files) {
		debug('check', `Adding file ${file} to the list of files to check.`);
		const text = fs.readFileSync(file, 'utf-8');
		checker.upsertDocument({
			uri: pathToFileURL(file).toString(),
			text,
		});
	}

	return files.length;
}

/**
 * Parse flags and sets defaults
 *
 * @param flags {Flags}
 */
function parseFlags(flags: Flags): CheckFlags {
	return {
		watch: flags.watch ?? false,
	};
}
