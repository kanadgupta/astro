import { dim } from 'kleur/colors';
import type fsMod from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ViteDevServer } from 'vite';
import type { AstroSettings } from '../../@types/astro';
import { createContentTypesGenerator } from '../../content/index.js';
import { globalContentConfigObserver } from '../../content/utils.js';
import { runHookConfigSetup } from '../../integrations/index.js';
import { setUpEnvTs } from '../../vite-plugin-inject-env-ts/index.js';
import { getTimeStat } from '../build/util.js';
import { AstroError, AstroErrorData } from '../errors/index.js';
import { info, LogOptions } from '../logger/core.js';

export type ProcessExit = 0 | 1;

export type SyncParameters = {
	settings: AstroSettings;
	logging: LogOptions;
	fs: typeof fsMod;
	viteServer: ViteDevServer;
};

export async function syncCli({
	logging,
	settings,
	...restOfParameters
}: SyncParameters): Promise<ProcessExit> {
	const resolvedSettings = await runHookConfigSetup({
		settings,
		logging,
		command: 'build',
	});
	return sync({ settings: resolvedSettings, logging, ...restOfParameters });
}

/**
 * Generate content collection types, and then returns the process exit signal.
 *
 * A non-zero process signal is emitted in case there's an error while generating content collection types.
 *
 * @param {SyncParameters} options
 * @param {AstroSettings} options.settings Astro settings
 * @param {typeof fsMod} options.fs The file system
 * @param {LogOptions} options.logging Logging options
 * @param {ViteDevServer} options.viteServer Instance of the vite server
 * @return {Promise<ProcessExit>}
 */
export async function sync({
	logging,
	fs,
	settings,
	viteServer,
}: SyncParameters): Promise<ProcessExit> {
	const timerStart = performance.now();
	// Needed to load content config
	const tempViteServer = await createServer(
		await createVite(
			{
				server: { middlewareMode: true, hmr: false },
				optimizeDeps: { entries: [] },
				logLevel: 'silent',
			},
			{ settings, logging, mode: 'build', command: 'build', fs }
		)
	);

	try {
		const contentTypesGenerator = await createContentTypesGenerator({
			contentConfigObserver: globalContentConfigObserver,
			logging,
			fs,
			settings,
			viteServer,
		});
		const typesResult = await contentTypesGenerator.init();

		const contentConfig = globalContentConfigObserver.get();
		if (contentConfig.status === 'error') {
			throw contentConfig.error;
		}

		if (typesResult.typesGenerated === false) {
			switch (typesResult.reason) {
				case 'no-content-dir':
				default:
					info(logging, 'content', 'No content directory found. Skipping type generation.');
					return 0;
			}
		}
	} catch (e) {
		throw new AstroError(AstroErrorData.GenerateContentTypesError);
	}

	info(logging, 'content', `Types generated ${dim(getTimeStat(timerStart, performance.now()))}`);
	await setUpEnvTs({ settings, logging, fs });

	return 0;
}
